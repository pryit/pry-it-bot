import http from 'http';
import { Telegraf, Markup, session, Scenes } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_ID = 1038839260; 
const COMMISSION_RATE = 0.05; // 5% комиссия платформы

// Глобальный перехват ошибок
bot.catch((err, ctx) => {
    console.error(`[System Error]:`, err);
    try {
        ctx.reply('⚠️ Сталася системна помилка. Будь ласка, поверніться в меню /start.').catch(()=>{});
    } catch(e) {}
});

// --- ГОЛОВНЕ МЕНЮ ---
function getMainMenu(userId) {
    const buttons = [
        [Markup.button.callback('💼 Мій кабінет / Баланс', 'my_profile'), Markup.button.callback('📋 Біржа завдань', 'list_tasks')],
        [Markup.button.callback('📂 Мої завдання', 'my_active_tasks'), Markup.button.callback('📊 Історія угод', 'my_completed_tasks')],
        [Markup.button.callback('➕ Створити завдання', 'create_task')]
    ];
    
    if (userId === ADMIN_ID) {
        buttons.push([Markup.button.callback('⚙️ Панель управління (Адмін)', 'admin_main')]);
    }
    
    return Markup.inlineKeyboard(buttons);
}

const backButton = Markup.inlineKeyboard([[Markup.button.callback('🔙 В головне меню', 'main_menu')]]);

// --- СЦЕНА ПОПОВНЕННЯ БАЛАНСУ ---
const depositWizard = new Scenes.WizardScene(
    'depositWizard',
    async (ctx) => {
        await ctx.editMessageText('<b>💳 Поповнення балансу</b>\n\nВведіть суму у доларах США (USD) для поповнення (наприклад: 20, 50, 100):\n<i>(Надішліть /cancel для скасування)</i>', { parse_mode: 'HTML' }).catch(async ()=>{
            await ctx.reply('<b>💳 Поповнення балансу</b>\n\nВведіть суму у доларах США (USD):', { parse_mode: 'HTML' });
        });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.message.text === '/cancel') return cancelWizard(ctx);
        const amount = parseFloat(ctx.message.text);
        if (isNaN(amount) || amount < 1) {
            await ctx.reply('❌ Помилка: сума має бути цифрою більше 1$.', getMainMenu(ctx.from.id));
            return ctx.scene.leave();
        }

        const paymentToken = process.env.PAYMENT_PROVIDER_TOKEN;
        if (!paymentToken) {
            await ctx.reply('❌ <b>Платіжна система тимчасово недоступна.</b>\nАдміністратор ще не додав PAYMENT_PROVIDER_TOKEN у налаштуваннях сервера.', { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
            return ctx.scene.leave();
        }

        try {
            await ctx.replyWithInvoice({
                title: 'Поповнення балансу Pry.it',
                description: `Офіційне поповнення внутрішнього рахунку (Escrow) на $${amount}`,
                payload: `deposit_${ctx.from.id}_${amount}_${Date.now()}`,
                provider_token: paymentToken,
                currency: 'USD',
                prices: [{ label: 'Поповнення балансу (USD)', amount: Math.round(amount * 100) }], // В центах
                start_parameter: 'deposit'
            });
        } catch (error) {
            console.error('Помилка генерації інвойсу:', error);
            await ctx.reply('⚠️ <b>Не вдалося створити платіжний рахунок.</b>\nМожливо, платіжний токен недійсний або не підтримує USD.', { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
        }

        return ctx.scene.leave();
    }
);

// --- СЦЕНА ЗДАЧІ РОБОТИ ---
const submitProofWizard = new Scenes.WizardScene(
    'submitProofWizard',
    async (ctx) => {
        await ctx.editMessageText('<b>📤 Передача результатів роботи</b>\n\nНадішліть результати вашої роботи: <b>документ, архів, фотографію або посилання</b>.\n<i>(Надішліть /cancel для скасування)</i>', { parse_mode: 'HTML' }).catch(async ()=>{
            await ctx.reply('<b>📤 Передача результатів роботи</b>\n\nНадішліть результати вашої роботи (файл/посилання):', { parse_mode: 'HTML' });
        });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.message && ctx.message.text === '/cancel') return cancelWizard(ctx);
        
        const bountyId = ctx.wizard.state.bountyId;
        
        try {
            await supabase.from('bounties').update({ status: 'review' }).eq('id', bountyId).eq('executor_id', ctx.from.id);
            const { data: bounty } = await supabase.from('bounties').select('*').eq('id', bountyId).single();

            await ctx.reply('✅ <b>Звіт успішно передано модератору!</b>', { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });

            // Пересилаємо повідомлення (файл/текст) адміну
            await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Новий звіт (Proof of Work):</b>\n\nЗавдання: <b>${bounty.title}</b>\nВиконавець: <code>${ctx.from.id}</code>\nМатеріали прикріплено нижче ⬇️`, { parse_mode: 'HTML' });
            await ctx.copyMessage(ADMIN_ID);

            const netPay = (bounty.reward * (1 - COMMISSION_RATE)).toFixed(2);
            await bot.telegram.sendMessage(ADMIN_ID, `Рішення по завданню #${bountyId}:`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(`✅ Схвалити та виплатити $${netPay}`, `adm_app_rev_${bountyId}`)],
                    [Markup.button.callback('🔄 Відхилити (На доопрацювання)', `adm_rej_rev_${bountyId}`)]
                ])
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
        await ctx.editMessageText('<b>Створення завдання (1/3)</b>\n\nВведіть коротку та чітку назву.', { parse_mode: 'HTML' }).catch(async () => {
            await ctx.reply('<b>Створення завдання (1/3)</b>\n\nВведіть коротку та чітку назву.', { parse_mode: 'HTML' });
        });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.message.text === '/cancel') return cancelWizard(ctx);
        ctx.wizard.state.title = ctx.message.text;
        await ctx.reply('<b>Бюджет завдання (2/3)</b>\n\nВведіть суму винагороди в USD (наприклад: 50):', { parse_mode: 'HTML' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.message.text === '/cancel') return cancelWizard(ctx);
        const reward = parseFloat(ctx.message.text);
        if (isNaN(reward) || reward <= 0) {
            await ctx.reply('❌ Помилка: сума має бути більше 0.', getMainMenu(ctx.from.id));
            return ctx.scene.leave();
        }

        const { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
        const currentBalance = user?.balance || 0;

        if (currentBalance < reward) {
            await ctx.reply(
                `⚠ <b>Недостатньо коштів на балансі (Escrow)!</b>\n\nВаш баланс: <b>$${currentBalance}</b>\nНеобхідно для старту: <b>$${reward}</b>\n\nПоповніть баланс, щоб система могла гарантувати виплату виконавцю.`, 
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('💳 Поповнити баланс', 'deposit_start')], [Markup.button.callback('🔙 В меню', 'main_menu')]]) }
            );
            return ctx.scene.leave();
        }

        ctx.wizard.state.reward = reward;
        await ctx.reply('<b>Технічне завдання (3/3)</b>\n\nОпишіть вимоги та що саме потрібно зробити:', { parse_mode: 'HTML' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.message.text === '/cancel') return cancelWizard(ctx);
        ctx.wizard.state.description = ctx.message.text;
        const { title, reward, description } = ctx.wizard.state;

        try {
            // Заморожуємо кошти
            const { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
            const newBalance = user.balance - reward;
            const newFrozen = (user.frozen_balance || 0) + reward;

            await supabase.from('users').update({ balance: newBalance, frozen_balance: newFrozen }).eq('telegram_id', ctx.from.id);
            await supabase.from('bounties').insert([{ title, reward, description, status: 'pending_approval', creator_id: ctx.from.id }]);
            
            await ctx.reply(`✅ <b>Завдання на модерації</b>\n\nСума <b>$${reward}</b> зарезервована системою (Escrow). Після перевірки воно з'явиться на біржі.`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
            try { await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Нове завдання на модерації</b>\nСума: $${reward}`, { parse_mode: 'HTML' }); } catch (e) {}
        } catch (err) {
            await ctx.reply('⚠️ Помилка створення.', getMainMenu(ctx.from.id));
        }
        return ctx.scene.leave();
    }
);

async function cancelWizard(ctx) {
    await ctx.reply('❌ Операцію скасовано.', getMainMenu(ctx.from.id));
    return ctx.scene.leave();
}

const stage = new Scenes.Stage([createTaskWizard, depositWizard, submitProofWizard]);
bot.use(session());
bot.use(stage.middleware());

// --- ОБРОБКА ПЛАТЕЖІВ ---
bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));

bot.on('successful_payment', async (ctx) => {
    const payment = ctx.message.successful_payment;
    const amount = payment.total_amount / 100;

    try {
        const { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
        const updatedBalance = (user?.balance || 0) + amount;
        await supabase.from('users').update({ balance: updatedBalance }).eq('telegram_id', ctx.from.id);

        await ctx.reply(`🎉 <b>Оплата успішна!</b>\nПоточний баланс: <b>$${updatedBalance}</b>`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
    } catch (err) {}
});

// --- СТАРТ ---
bot.start(async (ctx) => {
    try {
        await supabase.from('users').upsert({ telegram_id: ctx.from.id, username: ctx.from.username || null, first_name: ctx.from.first_name || 'Користувач' }, { onConflict: 'telegram_id' });
        await ctx.reply(`Платформа <b>Pry.it</b>\n\nОфіційний гарант-сервіс безпечних угод.`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });
    } catch (err) {
        await ctx.reply('Система готова до роботи.', getMainMenu(ctx.from.id));
    }
});

bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Платформа <b>Pry.it</b>\n\nОфіційний гарант-сервіс безпечних угод.`, { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) }).catch(()=>{});
});

bot.action('deposit_start', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('depositWizard');
});

bot.action('create_task', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('createTaskWizard');
});

bot.action('my_profile', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
        const profileText = `💼 <b>Особистий кабінет</b>\n\nКористувач: <b>${user?.first_name || ctx.from.first_name}</b>\nID: <code>${ctx.from.id}</code>\n\n💳 <b>Фінансовий стан:</b>\n ├ Доступний баланс: <b>$${user?.balance || 0}</b>\n └ В резерві (Escrow): <b>$${user?.frozen_balance || 0}</b>`;
        await ctx.editMessageText(profileText, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('💳 Поповнити баланс', 'deposit_start')], [Markup.button.callback('🔙 В меню', 'main_menu')]]) }).catch(()=>{});
    } catch (err) {}
});

bot.action('list_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: bounties } = await supabase.from('bounties').select('*').eq('status', 'open');
        if (!bounties || bounties.length === 0) return ctx.editMessageText('📭 <b>Біржа порожня.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});

        await ctx.deleteMessage().catch(()=>{}); 
        await ctx.reply('📋 <b>Доступні завдання:</b>', { parse_mode: 'HTML' });
        for (const bounty of bounties) {
            const netReward = (bounty.reward * (1 - COMMISSION_RATE)).toFixed(2);
            await ctx.reply(`<b>${bounty.title}</b>\nВинагорода: <b>$${netReward}</b> <i>(комісія гаранта 5%)</i>\nТЗ: ${bounty.description}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('Взяти в роботу', `take_${bounty.id}`)]]) });
        }
    } catch (err) {}
});

bot.action('my_active_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: activeTasks } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'in_progress');
        if (!activeTasks || activeTasks.length === 0) return ctx.editMessageText('📭 <b>Немає активних завдань.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});

        await ctx.deleteMessage().catch(()=>{});
        await ctx.reply('📂 <b>Завдання в роботі:</b>', { parse_mode: 'HTML' });
        for (const bounty of activeTasks) {
            await ctx.reply(`<b>${bounty.title}</b>\nВинагорода: $${(bounty.reward * (1-COMMISSION_RATE)).toFixed(2)}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Здати на перевірку', `submit_start_${bounty.id}`)], [Markup.button.callback('❌ Відмовитися', `cancel_task_${bounty.id}`)]])});
        }
    } catch (err) {}
});

bot.action('my_completed_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: completedTasks } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'completed');
        if (!completedTasks || completedTasks.length === 0) return ctx.editMessageText('📭 <b>Історія порожня.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});

        await ctx.deleteMessage().catch(()=>{});
        await ctx.reply('📊 <b>Історія угод:</b>', { parse_mode: 'HTML' });
        for (const bounty of completedTasks) {
            await ctx.reply(`✅ <b>${bounty.title}</b>\nОплачено: <b>$${(bounty.reward * (1-COMMISSION_RATE)).toFixed(2)}</b>`, { parse_mode: 'HTML' });
        }
        await ctx.reply('Навігація:', backButton);
    } catch (err) {}
});

bot.action(/submit_start_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('submitProofWizard', { bountyId: ctx.match[1] });
});

bot.action(/take_(.+)/, async (ctx) => {
    const bountyId = ctx.match[1];
    await supabase.from('bounties').update({ status: 'in_progress', executor_id: ctx.from.id }).eq('id', bountyId);
    await ctx.answerCbQuery('✅ Завдання закріплено');
    await ctx.editMessageText(`✅ <b>Статус: В роботі.</b>\nНадішліть результати після виконання.`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Здати на перевірку', `submit_start_${bountyId}`)], [Markup.button.callback('🔙 В меню', 'main_menu')]]) }).catch(()=>{});
});

bot.action(/cancel_task_(.+)/, async (ctx) => {
    await supabase.from('bounties').update({ status: 'open', executor_id: null }).eq('id', ctx.match[1]).eq('executor_id', ctx.from.id);
    await ctx.answerCbQuery('Відмова зафіксована');
    await ctx.editMessageText('❌ <b>Ви відмовилися від завдання.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
});

// ==========================================
// ⚙️ АДМІН-ПАНЕЛЬ
// ==========================================
function getAdminMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📝 Модерація', 'admin_pub_list'), Markup.button.callback('🔍 Аудит звітів', 'admin_rev_list')],
        [Markup.button.callback('🗑 База даних', 'admin_man_list'), Markup.button.callback('🔙 В меню', 'main_menu')]
    ]);
}

bot.action('admin_main', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔');
    await ctx.editMessageText('⚙️ <b>Панель Адміністратора</b>', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
});

bot.action('admin_pub_list', async (ctx) => {
    const { data: tasks } = await supabase.from('bounties').select('*').eq('status', 'pending_approval');
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Немає завдань на модерацію.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    
    await ctx.deleteMessage().catch(()=>{});
    for (const t of tasks) {
        await ctx.reply(`<b>${t.title}</b>\nБюджет: $${t.reward}\nТЗ: ${t.description}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Опублікувати', `adm_app_pub_${t.id}`), Markup.button.callback('❌ Відхилити', `adm_rej_pub_${t.id}`)]])});
    }
    await ctx.reply('Навігація:', { ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В адмін-панель', 'admin_main')]]) });
});

bot.action(/adm_app_pub_(.+)/, async (ctx) => {
    await supabase.from('bounties').update({ status: 'open' }).eq('id', ctx.match[1]);
    await ctx.editMessageText('✅ <b>Опубліковано.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action(/adm_rej_pub_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: bounty } = await supabase.from('bounties').select('*').eq('id', id).single();
    if (bounty) {
        const { data: creator } = await supabase.from('users').select('*').eq('telegram_id', bounty.creator_id).single();
        if (creator) {
            await supabase.from('users').update({ balance: creator.balance + bounty.reward, frozen_balance: Math.max(0, creator.frozen_balance - bounty.reward) }).eq('telegram_id', bounty.creator_id);
        }
        await supabase.from('bounties').delete().eq('id', id);
    }
    await ctx.editMessageText('❌ <b>Відхилено. Кошти повернуто.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action('admin_rev_list', async (ctx) => {
    const { data: tasks } = await supabase.from('bounties').select('*').eq('status', 'review');
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Немає звітів.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    
    await ctx.deleteMessage().catch(()=>{});
    for (const t of tasks) {
        const netReward = (t.reward * (1 - COMMISSION_RATE)).toFixed(2);
        await ctx.reply(`<b>${t.title}</b>\nВиконавець: <code>${t.executor_id}</code>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback(`✅ Виплатити $${netReward}`, `adm_app_rev_${t.id}`)], [Markup.button.callback('🔄 На доопрацювання', `adm_rej_rev_${t.id}`)]])});
    }
    await ctx.reply('Навігація:', { ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В адмінку', 'admin_main')]]) });
});

bot.action(/adm_app_rev_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: bounty } = await supabase.from('bounties').select('*').eq('id', id).single();
    if (bounty) {
        const netReward = bounty.reward * (1 - COMMISSION_RATE);
        const { data: creator } = await supabase.from('users').select('*').eq('telegram_id', bounty.creator_id).single();
        if (creator) await supabase.from('users').update({ frozen_balance: Math.max(0, creator.frozen_balance - bounty.reward) }).eq('telegram_id', bounty.creator_id);

        const { data: executor } = await supabase.from('users').select('*').eq('telegram_id', bounty.executor_id).single();
        if (executor) await supabase.from('users').update({ balance: (executor.balance || 0) + netReward }).eq('telegram_id', bounty.executor_id);

        await supabase.from('bounties').update({ status: 'completed' }).eq('id', id);
        await ctx.editMessageText('✅ <b>Завдання закрито, кошти перераховано.</b>', { parse_mode: 'HTML' }).catch(()=>{});
        try { await bot.telegram.sendMessage(bounty.executor_id, `🎉 Роботу <b>${bounty.title}</b> схвалено! Зараховано <b>$${netReward.toFixed(2)}</b>`, { parse_mode: 'HTML' }); } catch(e){}
    }
});

bot.action(/adm_rej_rev_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: bounty } = await supabase.from('bounties').select('*').eq('id', id).single();
    await supabase.from('bounties').update({ status: 'in_progress' }).eq('id', id);
    await ctx.editMessageText('🔄 <b>Повернуто на доопрацювання.</b>', { parse_mode: 'HTML' }).catch(()=>{});
    try { await bot.telegram.sendMessage(bounty.executor_id, `⚠ Роботу <b>${bounty.title}</b> відхилено. Надішліть новий звіт.`, { parse_mode: 'HTML' }); } catch(e){}
});

bot.action('admin_man_list', async (ctx) => {
    const { data: tasks } = await supabase.from('bounties').select('*').in('status', ['open', 'in_progress']);
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Активних завдань немає.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    
    await ctx.deleteMessage().catch(()=>{});
    for (const t of tasks) {
        await ctx.reply(`<b>${t.title}</b>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🗑 Видалити', `adm_del_task_${t.id}`)]])});
    }
    await ctx.reply('Навігація:', { ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В адмінку', 'admin_main')]]) });
});

bot.action(/adm_del_task_(.+)/, async (ctx) => {
    await supabase.from('bounties').delete().eq('id', ctx.match[1]);
    await ctx.editMessageText('🗑 <b>Видалено.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.launch({ dropPendingUpdates: true });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

http.createServer((req, res) => {
    res.writeHead(200); res.end('Pry.it API Active.');
}).listen(process.env.PORT || 3000);
