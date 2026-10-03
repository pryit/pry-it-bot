import http from 'http';
import { Telegraf, Markup, session, Scenes } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_ID = 1038839260; 
const COMMISSION_RATE = 0.05;

bot.catch((err, ctx) => {
    console.error(`[КРИТИЧНА ПОМИЛКА]:`, err);
    try { ctx.reply('⚠️ Сталася системна помилка. Натисніть /start').catch(()=>{}); } catch(e) {}
});

// Синхронізація з БД
async function syncUser(ctx) {
    let { data: user, error: fetchErr } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).maybeSingle();
    if (fetchErr) throw fetchErr;

    if (!user) {
        user = {
            telegram_id: ctx.from.id,
            username: ctx.from.username || null,
            first_name: ctx.from.first_name || 'Користувач',
            balance: 0,
            frozen_balance: 0
        };
        const { error: insErr } = await supabase.from('users').insert([user]);
        if (insErr) throw insErr;
    }
    return user;
}

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

// --- УНІВЕРСАЛЬНИЙ ПЕРЕХОПЛЮВАЧ КОМАНД (/start, /cancel) ---
async function checkCommand(ctx) {
    const text = ctx.message?.text;
    if (text === '/cancel') {
        await ctx.scene.leave();
        await ctx.reply('❌ Дію скасовано.', getMainMenu(ctx.from.id));
        return true;
    }
    if (text === '/start') {
        await ctx.scene.leave();
        await syncUser(ctx);
        await ctx.reply(`Платформа <b>Pry.it</b>\nГоловне меню.`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
        return true;
    }
    return false;
}

// --- 1. СЦЕНА ПОПОВНЕННЯ ---
const depositWizard = new Scenes.WizardScene(
    'depositWizard',
    async (ctx) => {
        await ctx.editMessageText('<b>🔧 Режим тестування (Dev Mode)</b>\n\nВведіть суму в USD для миттєвого віртуального поповнення балансу:', { parse_mode: 'HTML' }).catch(async ()=>{
            await ctx.reply('<b>🔧 Режим тестування</b>\nВведіть суму в USD: (наприклад: 50)', { parse_mode: 'HTML' });
        });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkCommand(ctx)) return;

        const amount = parseFloat(ctx.message?.text?.replace(',', '.'));
        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('❌ Невірна сума. Будь ласка, введіть просто число (наприклад: 50):');
            return;
        }

        try {
            const user = await syncUser(ctx);
            const updatedBalance = Number(((user.balance || 0) + amount).toFixed(2));
            
            const { error: updErr } = await supabase.from('users').update({ balance: updatedBalance }).eq('telegram_id', ctx.from.id);
            if (updErr) throw updErr;

            await ctx.reply(`✅ <b>Тестове поповнення успішне!</b>\n\nНа ваш баланс зараховано: <b>$${amount.toFixed(2)}</b>\nПоточний баланс: <b>$${updatedBalance}</b>`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
            return ctx.scene.leave();
        } catch (err) {
            console.error('Помилка БД:', err);
            await ctx.reply(`⚠️ Помилка БД. Переконайтеся, що ви вимкнули RLS у Supabase.`, getMainMenu(ctx.from.id));
            return ctx.scene.leave();
        }
    }
);

// --- 2. СЦЕНА ЗДАЧІ РОБОТИ ---
const submitProofWizard = new Scenes.WizardScene(
    'submitProofWizard',
    async (ctx) => {
        await ctx.editMessageText('<b>📤 Передача результатів роботи</b>\n\nНадішліть результати вашої роботи (файл, архів, фото або текст).', { parse_mode: 'HTML' }).catch(async ()=>{
            await ctx.reply('Надішліть файл або текст з результатом:');
        });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkCommand(ctx)) return;

        const bountyId = ctx.wizard.state.bountyId;
        try {
            await supabase.from('bounties').update({ status: 'review' }).eq('id', bountyId).eq('executor_id', ctx.from.id);
            const { data: bounty } = await supabase.from('bounties').select('*').eq('id', bountyId).single();

            await ctx.reply('✅ <b>Звіт успішно передано модератору!</b>', { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
            await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Новий звіт (ID: ${bountyId}):</b>\nЗавдання: <b>${bounty.title}</b>\nМатеріали прикріплено нижче ⬇️`, { parse_mode: 'HTML' });
            await ctx.copyMessage(ADMIN_ID);

            const netPay = Number((bounty.reward * (1 - COMMISSION_RATE)).toFixed(2));
            await bot.telegram.sendMessage(ADMIN_ID, `Рішення по завданню #${bountyId}:`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback(`✅ Схвалити та виплатити $${netPay}`, `adm_app_rev_${bountyId}`)], [Markup.button.callback('🔄 Відхилити', `adm_rej_rev_${bountyId}`)]])
            });
            return ctx.scene.leave();
        } catch (err) {
            await ctx.reply('⚠️ Помилка надсилання звіту.', getMainMenu(ctx.from.id));
            return ctx.scene.leave();
        }
    }
);

// --- 3. СЦЕНА СТВОРЕННЯ ЗАВДАННЯ ---
const createTaskWizard = new Scenes.WizardScene(
    'createTaskWizard',
    async (ctx) => {
        await ctx.editMessageText('<b>Створення завдання (1/3)</b>\nВведіть коротку назву:', { parse_mode: 'HTML' }).catch(async () => { await ctx.reply('Введіть назву завдання:'); });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkCommand(ctx)) return;
        ctx.wizard.state.title = ctx.message.text;
        await ctx.reply('<b>Бюджет в USD (2/3)</b>\nВведіть суму (наприклад: 50):', { parse_mode: 'HTML' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (await checkCommand(ctx)) return;
        const reward = parseFloat(ctx.message?.text?.replace(',', '.'));
        if (isNaN(reward) || reward <= 0) {
            await ctx.reply('❌ Невірна сума. Введіть число.');
            return;
        }
        try {
            const user = await syncUser(ctx);
            if ((user.balance || 0) < reward) {
                await ctx.reply(`⚠ <b>Недостатньо коштів!</b>\nБаланс: <b>$${user.balance || 0}</b>\nПотрібно: <b>$${reward}</b>`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
                return ctx.scene.leave();
            }
            ctx.wizard.state.reward = reward;
            await ctx.reply('<b>ТЗ (3/3)</b>\nОпишіть завдання:', { parse_mode: 'HTML' });
            return ctx.wizard.next();
        } catch (err) {
            await ctx.reply('⚠️ Помилка бази.', getMainMenu(ctx.from.id));
            return ctx.scene.leave();
        }
    },
    async (ctx) => {
        if (await checkCommand(ctx)) return;
        const { title, reward } = ctx.wizard.state;
        const description = ctx.message.text;

        try {
            const user = await syncUser(ctx);
            const newBalance = Number((user.balance - reward).toFixed(2));
            const newFrozen = Number(((user.frozen_balance || 0) + reward).toFixed(2));

            await supabase.from('users').update({ balance: newBalance, frozen_balance: newFrozen }).eq('telegram_id', ctx.from.id);
            await supabase.from('bounties').insert([{ title, reward, description, status: 'pending_approval', creator_id: ctx.from.id }]);
            
            await ctx.reply(`✅ <b>Завдання на модерації</b>\nСума <b>$${reward}</b> зарезервована (Escrow).`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
            try { await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Нове завдання:</b>\nНазва: ${title}\nСума: $${reward}`, { parse_mode: 'HTML' }); } catch(e){}
            return ctx.scene.leave();
        } catch (err) { 
            await ctx.reply('⚠️ Помилка створення.', getMainMenu(ctx.from.id)); 
            return ctx.scene.leave();
        }
    }
);

const stage = new Scenes.Stage([createTaskWizard, depositWizard, submitProofWizard]);
bot.use(session());

// Автовихід при натисканні inline-кнопок
bot.on('callback_query', async (ctx, next) => {
    if (ctx.scene && ctx.scene.current) await ctx.scene.leave();
    return next();
});

bot.use(stage.middleware());

bot.start(async (ctx) => {
    try {
        await syncUser(ctx);
        await ctx.reply(`Платформа <b>Pry.it</b>\nОфіційний гарант-сервіс безпечних угод.`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
    } catch (err) { await ctx.reply('БД перезавантажується.', getMainMenu(ctx.from.id)); }
});

bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Платформа <b>Pry.it</b>\nГоловне меню.`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) }).catch(()=>{});
});

bot.action('deposit_start', async (ctx) => { await ctx.answerCbQuery(); await ctx.scene.enter('depositWizard'); });
bot.action('create_task', async (ctx) => { await ctx.answerCbQuery(); await ctx.scene.enter('createTaskWizard'); });

bot.action('my_profile', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const user = await syncUser(ctx);
        await ctx.editMessageText(`💼 <b>Особистий кабінет</b>\n\nID: <code>${ctx.from.id}</code>\n\n💳 <b>Фінансовий стан:</b>\n ├ Вільний баланс: <b>$${user.balance || 0}</b>\n └ В резерві (Escrow): <b>$${user.frozen_balance || 0}</b>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('💳 Поповнити (Тест)', 'deposit_start')], [Markup.button.callback('🔙 В меню', 'main_menu')]]) }).catch(()=>{});
    } catch(e) { await ctx.answerCbQuery('Помилка', {show_alert: true}); }
});

bot.action('list_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    const { data: bounties } = await supabase.from('bounties').select('*').eq('status', 'open');
    if (!bounties || bounties.length === 0) return ctx.editMessageText('📭 <b>Біржа порожня.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
    await ctx.deleteMessage().catch(()=>{}); 
    await ctx.reply('📋 <b>Доступні завдання:</b>', { parse_mode: 'HTML' });
    for (const b of bounties) {
        const netReward = Number((b.reward * (1 - COMMISSION_RATE)).toFixed(2));
        await ctx.reply(`<b>${b.title}</b>\nВинагорода: <b>$${netReward}</b> <i>(-5% комісії)</i>\nТЗ: ${b.description}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('Взяти в роботу', `take_${b.id}`)]]) });
    }
    await ctx.reply('Навігація:', backButton);
});

bot.action('my_active_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    const { data: active } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'in_progress');
    if (!active || active.length === 0) return ctx.editMessageText('📭 <b>Немає активних завдань.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
    await ctx.deleteMessage().catch(()=>{});
    for (const b of active) {
        await ctx.reply(`<b>${b.title}</b>\nСтатус: В роботі`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Здати результат', `submit_start_${b.id}`)], [Markup.button.callback('❌ Відмовитися', `cancel_task_${b.id}`)]])});
    }
    await ctx.reply('Навігація:', backButton);
});

bot.action('my_completed_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    const { data: completed } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'completed');
    if (!completed || completed.length === 0) return ctx.editMessageText('📭 <b>Історія порожня.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
    await ctx.deleteMessage().catch(()=>{});
    for (const b of completed) {
        const netReward = Number((b.reward * (1 - COMMISSION_RATE)).toFixed(2));
        await ctx.reply(`✅ <b>${b.title}</b>\nОплачено: <b>$${netReward}</b>`, { parse_mode: 'HTML' });
    }
    await ctx.reply('Навігація:', backButton);
});

bot.action(/submit_start_(.+)/, async (ctx) => { await ctx.answerCbQuery(); await ctx.scene.enter('submitProofWizard', { bountyId: ctx.match[1] }); });

bot.action(/take_(.+)/, async (ctx) => {
    const { error: updErr } = await supabase.from('bounties').update({ status: 'in_progress', executor_id: ctx.from.id }).eq('id', ctx.match[1]).eq('status', 'open');
    if (updErr) return ctx.answerCbQuery('Помилка.', {show_alert: true});
    await ctx.answerCbQuery('✅ Взято в роботу');
    await ctx.editMessageText(`✅ <b>Завдання закріплено.</b>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Здати результат', `submit_start_${ctx.match[1]}`)], [Markup.button.callback('🔙 В меню', 'main_menu')]]) }).catch(()=>{});
});

bot.action(/cancel_task_(.+)/, async (ctx) => {
    await supabase.from('bounties').update({ status: 'open', executor_id: null }).eq('id', ctx.match[1]).eq('executor_id', ctx.from.id);
    await ctx.answerCbQuery('Відмова');
    await ctx.editMessageText('❌ <b>Ви відмовилися.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
});

// ==========================================
// ⚙️ АДМІН-ПАНЕЛЬ
// ==========================================
function getAdminMenu() {
    return Markup.inlineKeyboard([[Markup.button.callback('📝 Модерація', 'admin_pub_list'), Markup.button.callback('🔍 Аудит', 'admin_rev_list')], [Markup.button.callback('🔙 Меню', 'main_menu')]]);
}

bot.action('admin_main', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔', {show_alert: true});
    await ctx.editMessageText('⚙️ <b>Адмін-панель</b>', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
});

bot.action('admin_pub_list', async (ctx) => {
    const { data: tasks } = await supabase.from('bounties').select('*').eq('status', 'pending_approval');
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Немає завдань.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    await ctx.deleteMessage().catch(()=>{});
    for (const t of tasks) await ctx.reply(`<b>${t.title}</b>\nБюджет: $${t.reward}\nЗамовник: ${t.creator_id}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Опублікувати', `adm_app_pub_${t.id}`), Markup.button.callback('❌ Відхилити', `adm_rej_pub_${t.id}`)]])});
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
        if (c) await supabase.from('users').update({ balance: Number((c.balance + b.reward).toFixed(2)), frozen_balance: Number((Math.max(0, c.frozen_balance - b.reward)).toFixed(2)) }).eq('telegram_id', b.creator_id);
        await supabase.from('bounties').delete().eq('id', id);
    }
    await ctx.editMessageText('❌ <b>Відхилено, кошти повернуто.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action('admin_rev_list', async (ctx) => {
    const { data: tasks } = await supabase.from('bounties').select('*').eq('status', 'review');
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Немає звітів.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    await ctx.deleteMessage().catch(()=>{});
    for (const t of tasks) {
        const netReward = Number((t.reward * (1 - COMMISSION_RATE)).toFixed(2));
        await ctx.reply(`<b>${t.title}</b>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback(`✅ Виплатити $${netReward}`, `adm_app_rev_${t.id}`)], [Markup.button.callback('🔄 Відхилити', `adm_rej_rev_${t.id}`)]])});
    }
});

bot.action(/adm_app_rev_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: b } = await supabase.from('bounties').select('*').eq('id', id).single();
    if (b) {
        const netReward = Number((b.reward * (1 - COMMISSION_RATE)).toFixed(2));
        const { data: c } = await supabase.from('users').select('*').eq('telegram_id', b.creator_id).single();
        if (c) await supabase.from('users').update({ frozen_balance: Number((Math.max(0, c.frozen_balance - b.reward)).toFixed(2)) }).eq('telegram_id', b.creator_id);
        
        const { data: e } = await supabase.from('users').select('*').eq('telegram_id', b.executor_id).single();
        if (e) await supabase.from('users').update({ balance: Number(((e.balance || 0) + netReward).toFixed(2)) }).eq('telegram_id', b.executor_id);

        await supabase.from('bounties').update({ status: 'completed' }).eq('id', id);
        await ctx.editMessageText(`✅ <b>Виплачено $${netReward}.</b>`, { parse_mode: 'HTML' }).catch(()=>{});
        try { await bot.telegram.sendMessage(b.executor_id, `🎉 Роботу <b>${b.title}</b> схвалено!\nЗараховано: <b>$${netReward}</b>`, { parse_mode: 'HTML' }); } catch(e){}
    }
});

bot.action(/adm_rej_rev_(.+)/, async (ctx) => {
    await supabase.from('bounties').update({ status: 'in_progress' }).eq('id', ctx.match[1]);
    await ctx.editMessageText('🔄 <b>На доопрацювання.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.on('message', async (ctx, next) => {
    if (!ctx.scene || !ctx.scene.current) await ctx.reply('Оберіть дію з меню 👇', getMainMenu(ctx.from.id));
    return next();
});

bot.launch({ dropPendingUpdates: true });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

http.createServer((req, res) => { res.writeHead(200); res.end('Pry.it API Active.'); }).listen(process.env.PORT || 3000);
