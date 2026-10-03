import http from 'http';
import { Telegraf, Markup, session, Scenes } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_ID = 1038839260; 
const COMMISSION_RATE = 0.05; // 5% комиссия платформы

bot.catch((err, ctx) => {
    console.error(`[System Error]:`, err);
    try { ctx.reply('⚠️ Сталася системна помилка. Будь ласка, поверніться в меню /start.').catch(()=>{}); } catch(e) {}
});

function getMainMenu(userId) {
    const buttons = [
        [Markup.button.callback('💼 Мій кабінет / Баланс', 'my_profile'), Markup.button.callback('📋 Біржа завдань', 'list_tasks')],
        [Markup.button.callback('📂 Мої завдання', 'my_active_tasks'), Markup.button.callback('📊 Історія угод', 'my_completed_tasks')],
        [Markup.button.callback('➕ Створити завдання', 'create_task')]
    ];
    if (userId === ADMIN_ID) buttons.push([Markup.button.callback('⚙️ Панель управління (Адмін)', 'admin_main')]);
    return Markup.inlineKeyboard(buttons);
}
const backButton = Markup.inlineKeyboard([[Markup.button.callback('🔙 В головне меню', 'main_menu')]]);

// --- ТЕСТОВЕ ПОПОВНЕННЯ (ВІДЛАДКА) ---
const depositWizard = new Scenes.WizardScene(
    'depositWizard',
    async (ctx) => {
        await ctx.editMessageText('<b>🔧 Режим тестування (Dev Mode)</b>\n\nВведіть суму в USD для миттєвого віртуального поповнення балансу (наприклад: 100):', { parse_mode: 'HTML' }).catch(async ()=>{
            await ctx.reply('Введіть суму в USD для віртуального поповнення:');
        });
        return ctx.wizard.next();
    },
    async (ctx) => {
        const amount = parseFloat(ctx.message.text);
        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('❌ Невірна сума.', getMainMenu(ctx.from.id));
            return ctx.scene.leave();
        }

        try {
            const { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
            const updatedBalance = (user?.balance || 0) + amount;
            await supabase.from('users').update({ balance: updatedBalance }).eq('telegram_id', ctx.from.id);

            await ctx.reply(`✅ <b>Тестове поповнення успішне!</b>\n\nНа ваш баланс зараховано: <b>$${amount}</b>\nПоточний баланс: <b>$${updatedBalance}</b>`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
        } catch (err) {
            await ctx.reply('⚠️ Помилка БД.', getMainMenu(ctx.from.id));
        }
        return ctx.scene.leave();
    }
);

// --- СЦЕНА ЗДАЧІ РОБОТИ ---
const submitProofWizard = new Scenes.WizardScene(
    'submitProofWizard',
    async (ctx) => {
        await ctx.editMessageText('<b>📤 Передача результатів роботи</b>\n\nНадішліть результати вашої роботи: <b>файл, архів, фото або посилання</b>.', { parse_mode: 'HTML' }).catch(async ()=>{
            await ctx.reply('Надішліть файл або посилання:');
        });
        return ctx.wizard.next();
    },
    async (ctx) => {
        const bountyId = ctx.wizard.state.bountyId;
        try {
            await supabase.from('bounties').update({ status: 'review' }).eq('id', bountyId).eq('executor_id', ctx.from.id);
            const { data: bounty } = await supabase.from('bounties').select('*').eq('id', bountyId).single();

            await ctx.reply('✅ <b>Звіт передано модератору!</b>', { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });

            await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Новий звіт:</b>\nЗавдання: <b>${bounty.title}</b>\nМатеріали прикріплено нижче ⬇️`, { parse_mode: 'HTML' });
            await ctx.copyMessage(ADMIN_ID); // Пересилаємо файл/текст адміну

            const netPay = (bounty.reward * (1 - COMMISSION_RATE)).toFixed(2);
            await bot.telegram.sendMessage(ADMIN_ID, `Рішення по завданню #${bountyId}:`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback(`✅ Схвалити та виплатити $${netPay}`, `adm_app_rev_${bountyId}`)], [Markup.button.callback('🔄 Відхилити', `adm_rej_rev_${bountyId}`)]])
            });
        } catch (err) {
            await ctx.reply('⚠️ Помилка надсилання звіту.', getMainMenu(ctx.from.id));
        }
        return ctx.scene.leave();
    }
);

// --- СЦЕНА СТВОРЕННЯ ЗАВДАННЯ ---
const createTaskWizard = new Scenes.WizardScene(
    'createTaskWizard',
    async (ctx) => {
        await ctx.editMessageText('<b>Створення завдання (1/3)</b>\nВведіть назву:', { parse_mode: 'HTML' }).catch(async () => { await ctx.reply('Введіть назву:'); });
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.wizard.state.title = ctx.message.text;
        await ctx.reply('<b>Бюджет в USD (2/3)</b>\nВведіть суму (наприклад: 50):', { parse_mode: 'HTML' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        const reward = parseFloat(ctx.message.text);
        if (isNaN(reward) || reward <= 0) return ctx.scene.leave();

        const { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
        if ((user?.balance || 0) < reward) {
            await ctx.reply(`⚠ <b>Недостатньо коштів!</b> Ваш баланс: $${user?.balance || 0}. Потрібно: $${reward}.`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
            return ctx.scene.leave();
        }

        ctx.wizard.state.reward = reward;
        await ctx.reply('<b>ТЗ (3/3)</b>\nОпишіть завдання:', { parse_mode: 'HTML' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.wizard.state.description = ctx.message.text;
        const { title, reward, description } = ctx.wizard.state;

        try {
            const { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
            await supabase.from('users').update({ balance: user.balance - reward, frozen_balance: (user.frozen_balance || 0) + reward }).eq('telegram_id', ctx.from.id);
            await supabase.from('bounties').insert([{ title, reward, description, status: 'pending_approval', creator_id: ctx.from.id }]);
            
            await ctx.reply(`✅ <b>Завдання на модерації</b>\nСума $${reward} зарезервована (Escrow).`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
            try { await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Нове завдання:</b> ${title}\nСума: $${reward}`, { parse_mode: 'HTML' }); } catch(e){}
        } catch (err) { await ctx.reply('⚠️ Помилка створення.', getMainMenu(ctx.from.id)); }
        return ctx.scene.leave();
    }
);

const stage = new Scenes.Stage([createTaskWizard, depositWizard, submitProofWizard]);
bot.use(session());
bot.use(stage.middleware());

bot.start(async (ctx) => {
    try {
        await supabase.from('users').upsert({ telegram_id: ctx.from.id, username: ctx.from.username, first_name: ctx.from.first_name || 'Користувач' }, { onConflict: 'telegram_id' });
        await ctx.reply(`Платформа <b>Pry.it</b>\nГарант-сервіс.`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
    } catch (err) { await ctx.reply('Система готова.', getMainMenu(ctx.from.id)); }
});

bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Платформа <b>Pry.it</b>`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) }).catch(()=>{});
});

bot.action('deposit_start', async (ctx) => { await ctx.answerCbQuery(); await ctx.scene.enter('depositWizard'); });
bot.action('create_task', async (ctx) => { await ctx.answerCbQuery(); await ctx.scene.enter('createTaskWizard'); });

bot.action('my_profile', async (ctx) => {
    await ctx.answerCbQuery();
    const { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
    await ctx.editMessageText(`💼 <b>Особистий кабінет</b>\n\nВільний баланс: <b>$${user?.balance || 0}</b>\nВ резерві (Escrow): <b>$${user?.frozen_balance || 0}</b>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('💳 Поповнити (Тест)', 'deposit_start')], [Markup.button.callback('🔙 Меню', 'main_menu')]]) }).catch(()=>{});
});

bot.action('list_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    const { data: bounties } = await supabase.from('bounties').select('*').eq('status', 'open');
    if (!bounties || bounties.length === 0) return ctx.editMessageText('📭 <b>Біржа порожня.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
    await ctx.deleteMessage().catch(()=>{}); 
    for (const b of bounties) {
        await ctx.reply(`<b>${b.title}</b>\nВинагорода: $${(b.reward * (1 - COMMISSION_RATE)).toFixed(2)}\nТЗ: ${b.description}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('Взяти в роботу', `take_${b.id}`)]]) });
    }
});

bot.action('my_active_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    const { data: active } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'in_progress');
    if (!active || active.length === 0) return ctx.editMessageText('📭 <b>Немає активних завдань.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
    await ctx.deleteMessage().catch(()=>{});
    for (const b of active) {
        await ctx.reply(`<b>${b.title}</b>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Здати', `submit_start_${b.id}`)], [Markup.button.callback('❌ Відмовитися', `cancel_task_${b.id}`)]])});
    }
});

bot.action('my_completed_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    const { data: completed } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'completed');
    if (!completed || completed.length === 0) return ctx.editMessageText('📭 <b>Історія порожня.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
    await ctx.deleteMessage().catch(()=>{});
    for (const b of completed) await ctx.reply(`✅ <b>${b.title}</b>\nОплачено: $${(b.reward * 0.95).toFixed(2)}`, { parse_mode: 'HTML' });
});

bot.action(/submit_start_(.+)/, async (ctx) => { await ctx.answerCbQuery(); await ctx.scene.enter('submitProofWizard', { bountyId: ctx.match[1] }); });

bot.action(/take_(.+)/, async (ctx) => {
    await supabase.from('bounties').update({ status: 'in_progress', executor_id: ctx.from.id }).eq('id', ctx.match[1]);
    await ctx.answerCbQuery('✅ Взято в роботу');
    await ctx.editMessageText(`✅ <b>В роботі.</b>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Здати', `submit_start_${ctx.match[1]}`)], [Markup.button.callback('🔙 В меню', 'main_menu')]]) }).catch(()=>{});
});

bot.action(/cancel_task_(.+)/, async (ctx) => {
    await supabase.from('bounties').update({ status: 'open', executor_id: null }).eq('id', ctx.match[1]).eq('executor_id', ctx.from.id);
    await ctx.answerCbQuery('Відмова');
    await ctx.editMessageText('❌ <b>Ви відмовилися.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
});

function getAdminMenu() {
    return Markup.inlineKeyboard([[Markup.button.callback('📝 Модерація', 'admin_pub_list'), Markup.button.callback('🔍 Звіти', 'admin_rev_list')], [Markup.button.callback('🔙 В меню', 'main_menu')]]);
}

bot.action('admin_main', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔');
    await ctx.editMessageText('⚙️ <b>Адмін-панель</b>', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
});

bot.action('admin_pub_list', async (ctx) => {
    const { data: tasks } = await supabase.from('bounties').select('*').eq('status', 'pending_approval');
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Пусто.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    await ctx.deleteMessage().catch(()=>{});
    for (const t of tasks) await ctx.reply(`<b>${t.title}</b>\nБюджет: $${t.reward}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Опублікувати', `adm_app_pub_${t.id}`), Markup.button.callback('❌ Відхилити', `adm_rej_pub_${t.id}`)]])});
});

bot.action(/adm_app_pub_(.+)/, async (ctx) => {
    await supabase.from('bounties').update({ status: 'open' }).eq('id', ctx.match[1]);
    await ctx.editMessageText('✅ <b>Опубліковано.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action(/adm_rej_pub_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: b } = await supabase.from('bounties').select('*').eq('id', id).single();
    if (b) {
        const { data: c } = await supabase.from('users').select('*').eq('telegram_id', b.creator_id).single();
        if (c) await supabase.from('users').update({ balance: c.balance + b.reward, frozen_balance: Math.max(0, c.frozen_balance - b.reward) }).eq('telegram_id', b.creator_id);
        await supabase.from('bounties').delete().eq('id', id);
    }
    await ctx.editMessageText('❌ <b>Відхилено, кошти повернуто.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action('admin_rev_list', async (ctx) => {
    const { data: tasks } = await supabase.from('bounties').select('*').eq('status', 'review');
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Немає звітів.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    await ctx.deleteMessage().catch(()=>{});
    for (const t of tasks) {
        const netReward = (t.reward * (1 - COMMISSION_RATE)).toFixed(2);
        await ctx.reply(`<b>${t.title}</b>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback(`✅ Виплатити $${netReward}`, `adm_app_rev_${t.id}`)], [Markup.button.callback('🔄 На доопрацювання', `adm_rej_rev_${t.id}`)]])});
    }
});

bot.action(/adm_app_rev_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: b } = await supabase.from('bounties').select('*').eq('id', id).single();
    if (b) {
        const netReward = b.reward * (1 - COMMISSION_RATE);
        const { data: c } = await supabase.from('users').select('*').eq('telegram_id', b.creator_id).single();
        if (c) await supabase.from('users').update({ frozen_balance: Math.max(0, c.frozen_balance - b.reward) }).eq('telegram_id', b.creator_id);
        const { data: e } = await supabase.from('users').select('*').eq('telegram_id', b.executor_id).single();
        if (e) await supabase.from('users').update({ balance: (e.balance || 0) + netReward }).eq('telegram_id', b.executor_id);

        await supabase.from('bounties').update({ status: 'completed' }).eq('id', id);
        await ctx.editMessageText('✅ <b>Завдання закрито.</b>', { parse_mode: 'HTML' }).catch(()=>{});
    }
});

bot.action(/adm_rej_rev_(.+)/, async (ctx) => {
    await supabase.from('bounties').update({ status: 'in_progress' }).eq('id', ctx.match[1]);
    await ctx.editMessageText('🔄 <b>На доопрацювання.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.launch({ dropPendingUpdates: true });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

http.createServer((req, res) => { res.writeHead(200); res.end('Pry.it API Active.'); }).listen(process.env.PORT || 3000);
