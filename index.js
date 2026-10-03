import http from 'http';
import { Telegraf, Markup, session, Scenes } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_ID = 1038839260; 
const COMMISSION_RATE = 0.05; // Комиссия платформы 5%

// Официальный тестовый токен Telegram Payments (Sberbank/Stripe Test Provider)
const PAYMENT_PROVIDER_TOKEN = process.env.PAYMENT_PROVIDER_TOKEN || '284685063:TEST:NzA4O';

// --- СИСТЕМА БЕЗОПАСНОСТИ ТА ЛОГУВАННЯ ---
bot.catch((err, ctx) => {
    console.error(`[System Error]:`, err);
    try {
        ctx.reply('⚠️ Сталася системна помилка. Будь ласка, спробуйте пізніше або поверніться в меню /start.').catch(()=>{});
    } catch(e) {}
});

// --- ДИНАМІЧНЕ ГОЛОВНЕ МЕНЮ ---
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

// --- СЦЕНА ПОПОВНЕННЯ БАЛАНСУ (TELEGRAM PAYMENTS) ---
const depositWizard = new Scenes.WizardScene(
    'depositWizard',
    async (ctx) => {
        await ctx.editMessageText('<b>💳 Поповнення балансу</b>\n\nВведіть суму у доларах США (USD) для поповнення (наприклад: 20, 50, 100):\n<i>(Надішліть /cancel для скасування)</i>', { parse_mode: 'HTML' }).catch(async ()=>{
            await ctx.reply('<b>💳 Поповнення балансу</b>\n\nВведіть суму у доларах США (USD) для поповнення:', { parse_mode: 'HTML' });
        });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.message.text === '/cancel') return cancelWizard(ctx);
        const amount = parseFloat(ctx.message.text);
        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('❌ Помилка: сума має бути більшою за 0.', getMainMenu(ctx.from.id));
            return ctx.scene.leave();
        }

        // Формування офіційного рахунку (Invoice)
        await ctx.replyWithInvoice({
            title: 'Поповнення балансу Pry.it',
            description: `Офіційне поповнення внутрішнього рахунку Pry.it на $${amount}`,
            payload: `deposit_${ctx.from.id}_${amount}_${Date.now()}`,
            provider_token: PAYMENT_PROVIDER_TOKEN,
            currency: 'USD',
            prices: [{ label: 'Поповнення балансу', amount: Math.round(amount * 100) }], // в центах
            start_parameter: 'deposit'
        });

        return ctx.scene.leave();
    }
);

// --- СЦЕНА ЗДАЧІ РОБОТИ (З ФАЙЛАМИ ТА ЗВІТОМ) ---
const submitProofWizard = new Scenes.WizardScene(
    'submitProofWizard',
    async (ctx) => {
        await ctx.editMessageText('<b>📤 Передача результатів роботи</b>\n\nНадішліть звіт про виконане завдання. Ви можете відправити <b>текст, посилання, фото або файл (zip, pdf, doc)</b>.\n<i>(Надішліть /cancel для скасування)</i>', { parse_mode: 'HTML' }).catch(async ()=>{
            await ctx.reply('<b>📤 Передача результатів роботи</b>\n\nНадішліть звіт про виконане завдання (текст, посилання або файл):', { parse_mode: 'HTML' });
        });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.message && ctx.message.text === '/cancel') return cancelWizard(ctx);
        
        const bountyId = ctx.wizard.state.bountyId;
        
        try {
            // Оновлюємо статус в БД
            await supabase.from('bounties').update({ status: 'review' }).eq('id', bountyId).eq('executor_id', ctx.from.id);
            const { data: bounty } = await supabase.from('bounties').select('*').eq('id', bountyId).single();

            await ctx.reply('✅ <b>Звіт успішно передано на перевірку!</b>\nОчікуйте на рішення модератора.', { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) });

            // Пересилаємо докази в адмін-панель
            await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Отримано новий звіт по завданню:</b>\n\nНазва: <b>${bounty.title}</b>\nВиконавець: <code>${ctx.from.id}</code>\nНижче додано надані матеріали:`, { parse_mode: 'HTML' });
            
            // Копіюємо повідомлення виконавця адміну
            await ctx.copyMessage(ADMIN_ID);

            // Кнопки для адміна
            const netPay = (bounty.reward * (1 - COMMISSION_RATE)).toFixed(2);
            await bot.telegram.sendMessage(ADMIN_ID, `Оберіть рішення для завдання #${bountyId}:`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(`✅ Схвалити та виплатити $${netPay}`, `adm_app_rev_${bountyId}`)],
                    [Markup.button.callback('🔄 На доопрацювання', `adm_rej_rev_${bountyId}`)]
                ])
            });

        } catch (err) {
            console.error('Помилка надсилання звіту:', err);
            await ctx.reply('⚠️ Помилка надсилання звіту.', getMainMenu(ctx.from.id));
        }
        return ctx.scene.leave();
    }
);

// --- СЦЕНА СТВОРЕННЯ ЗАВДАННЯ ---
const createTaskWizard = new Scenes.WizardScene(
    'createTaskWizard',
    async (ctx) => {
        await ctx.editMessageText('<b>Створення завдання (1/3)</b>\n\nВведіть коротку та чітку назву.\n<i>(Надішліть /cancel для скасування)</i>', { parse_mode: 'HTML' }).catch(async () => {
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
            await ctx.reply('❌ Помилка: сума має бути числом більше 0.', getMainMenu(ctx.from.id));
            return ctx.scene.leave();
        }

        // Перевірка балансу замовника
        const { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
        const currentBalance = user?.balance || 0;

        if (currentBalance < reward) {
            await ctx.reply(
                `⚠️️ <b>Недостатньо коштів на балансі!</b>\n\nВаш баланс: <b>$${currentBalance}</b>\nНеобхідно: <b>$${reward}</b>\n\nПоповніть баланс через офіційну платіжну систему для публікації.`, 
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('💳 Поповнити баланс', 'deposit_start')], [Markup.button.callback('🔙 В меню', 'main_menu')]]) }
            );
            return ctx.scene.leave();
        }

        ctx.wizard.state.reward = reward;
        await ctx.reply('<b>Технічне завдання (3/3)</b>\n\nОпишіть детальні вимоги та критерії прийомки:', { parse_mode: 'HTML' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.message.text === '/cancel') return cancelWizard(ctx);
        ctx.wizard.state.description = ctx.message.text;
        const { title, reward, description } = ctx.wizard.state;

        try {
            // Заморожуємо кошти у замовника (Escrow)
            const { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
            const newBalance = user.balance - reward;
            const newFrozen = (user.frozen_balance || 0) + reward;

            await supabase.from('users').update({ balance: newBalance, frozen_balance: newFrozen }).eq('telegram_id', ctx.from.id);

            // Створюємо завдання
            const { error } = await supabase.from('bounties').insert([{ 
                title, reward, description, status: 'pending_approval', creator_id: ctx.from.id 
            }]);
            
            if (error) throw error;
            
            await ctx.reply(
                `✅ <b>Завдання відправлено на модерацію</b>\n\nСума <b>$${reward}</b> безпечно зарезервована системою (Escrow).\nПісля перевірки завдання з'явиться на біржі.`, 
                { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) }
            );

            try { 
                await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Нове завдання на модерації</b>\nКлієнт: <code>${ctx.from.id}</code>\nЗавдання: ${title}\nСума: $${reward}`, { parse_mode: 'HTML' }); 
            } catch (e) {}
            
        } catch (err) {
            await ctx.reply('⚠️ Помилка створення завдання.', getMainMenu(ctx.from.id));
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

// --- ОБРОБКА ПЛАТЕЖІВ TELEGRAM PAYMENTS ---
bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));

bot.on('successful_payment', async (ctx) => {
    const payment = ctx.message.successful_payment;
    const amount = payment.total_amount / 100;

    try {
        const { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
        const updatedBalance = (user?.balance || 0) + amount;

        await supabase.from('users').update({ balance: updatedBalance }).eq('telegram_id', ctx.from.id);

        await ctx.reply(
            `🎉 <b>Оплата успішна!</b>\n\nНа ваш баланс зараховано: <b>+$${amount}</b>\nПоточний баланс: <b>$${updatedBalance}</b>`,
            { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) }
        );
    } catch (err) {
        console.error('Помилка зарахування платежу:', err);
    }
});

// --- СТАРТ ТА ІНТЕРФЕЙС ---
bot.start(async (ctx) => {
    const from = ctx.from;
    try {
        await supabase.from('users').upsert(
            { telegram_id: from.id, username: from.username || null, first_name: from.first_name || 'Користувач' }, 
            { onConflict: 'telegram_id' }
        );
        
        await ctx.reply(
            `Платформа <b>Pry.it</b>\n\nОфіційний гарант-сервіс баунті-завдань та безпечних угод.`, 
            { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) }
        );
    } catch (err) {
        await ctx.reply('Система готова до роботи.', getMainMenu(ctx.from.id));
    }
});

bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `Платформа <b>Pry.it</b>\n\nОфіційний гарант-сервіс баунті-завдань та безпечних угод.`, 
        { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) }
    ).catch(()=>{});
});

bot.action('deposit_start', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('depositWizard');
});

bot.action('create_task', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('createTaskWizard');
});

// --- ПРОФІЛЬ ТА БАЛАНС ---
bot.action('my_profile', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
        const { data: completedBounties } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'completed');
        
        const count = completedBounties ? completedBounties.length : 0;
        const balance = user?.balance || 0;
        const frozen = user?.frozen_balance || 0;

        const profileText = `
💼 <b>Особистий кабінет</b>

Користувач: <b>${user?.first_name || ctx.from.first_name}</b>
Системний ID: <code>${ctx.from.id}</code>

💳 <b>Фінансовий стан:</b>
 ├ Доступний баланс: <b>$${balance}</b>
 └ В резерві (Escrow): <b>$${frozen}</b>

📊 <b>Статистика:</b>
 └ Успішних угод: <b>${count}</b>
        `;
        
        await ctx.editMessageText(profileText, { 
            parse_mode: 'HTML', 
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💳 Поповнити баланс', 'deposit_start')],
                [Markup.button.callback('🔙 До головного меню', 'main_menu')]
            ]) 
        }).catch(()=>{});
    } catch (err) {
        await ctx.answerCbQuery('Помилка завантаження профілю', {show_alert:true});
    }
});

// --- БІРЖА ЗАВДАНЬ ---
bot.action('list_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: bounties } = await supabase.from('bounties').select('*').eq('status', 'open');
        
        if (!bounties || bounties.length === 0) {
            return ctx.editMessageText('📭 <b>Біржа порожня.</b>\nНаразі немає відкритих завдань.', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
        }

        await ctx.deleteMessage().catch(()=>{}); 
        await ctx.reply('📋 <b>Доступні завдання на біржі:</b>', { parse_mode: 'HTML' });

        for (const bounty of bounties) {
            const netReward = (bounty.reward * (1 - COMMISSION_RATE)).toFixed(2);
            await ctx.reply(
                `<b>${bounty.title}</b>\n\nВинагорода: <b>$${netReward}</b> <i>(з урахуванням комісії гаранта 5%)</i>\nТЗ: ${bounty.description}\n🛡 <i>Бюджет зарезервовано гарантом</i>`, 
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('Взяти в роботу', `take_${bounty.id}`)]]) }
            );
        }
    } catch (err) {}
});

bot.action('my_active_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: activeTasks } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'in_progress');
        
        if (!activeTasks || activeTasks.length === 0) {
            return ctx.editMessageText('📭 <b>Немає активних завдань.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
        }

        await ctx.deleteMessage().catch(()=>{});
        await ctx.reply('📂 <b>Ваші завдання в роботі:</b>', { parse_mode: 'HTML' });

        for (const bounty of activeTasks) {
            await ctx.reply(
                `<b>${bounty.title}</b>\nВинагорода: $${(bounty.reward * 0.95).toFixed(2)}`, 
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Здати на перевірку', `submit_start_${bounty.id}`)],
                    [Markup.button.callback('❌ Відмовитися', `cancel_task_${bounty.id}`)]
                ])}
            );
        }
    } catch (err) {}
});

bot.action(/submit_start_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const bountyId = ctx.match[1];
    await ctx.scene.enter('submitProofWizard', { bountyId });
});

bot.action(/take_(.+)/, async (ctx) => {
  const bountyId = ctx.match[1];
  try {
    const { data: bounty, error } = await supabase.from('bounties').select('*').eq('id', bountyId).eq('status', 'open').single();
    if (error || !bounty) return ctx.answerCbQuery('❌ Завдання вже зайняте', {show_alert: true});

    await supabase.from('bounties').update({ status: 'in_progress', executor_id: ctx.from.id }).eq('id', bountyId);
    
    await ctx.answerCbQuery('✅ Завдання закріплено за вами');
    await ctx.editMessageText(
      `<b>${bounty.title}</b>\nВинагорода: $${(bounty.reward * 0.95).toFixed(2)}\n\n✅ <b>Статус: В роботі.</b>\nВиконайте ТЗ та надішліть результати (файли/посилання).`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Здати на перевірку', `submit_start_${bounty.id}`)], [Markup.button.callback('🔙 В меню', 'main_menu')]]) }
    ).catch(()=>{});
  } catch (err) { ctx.answerCbQuery('Помилка', {show_alert:true}); }
});

bot.action(/cancel_task_(.+)/, async (ctx) => {
    const bountyId = ctx.match[1];
    await supabase.from('bounties').update({ status: 'open', executor_id: null }).eq('id', bountyId).eq('executor_id', ctx.from.id);
    await ctx.answerCbQuery('Відмова зафіксована');
    await ctx.editMessageText('❌ <b>Ви відмовилися від завдання.</b>', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
});

// ==========================================
// ⚙️ ПАНЕЛЬ УПРАВЛІННЯ (АДМІН)
// ==========================================

function getAdminMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📝 Модерація нових завдань', 'admin_pub_list')],
        [Markup.button.callback('🔍 Перевірка звітів', 'admin_rev_list')],
        [Markup.button.callback('🗑 Управління базою', 'admin_man_list')],
        [Markup.button.callback('🔙 В головне меню', 'main_menu')]
    ]);
}

bot.action('admin_main', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Відмовлено в доступі.', { show_alert: true });
    await ctx.answerCbQuery();
    await ctx.editMessageText('⚙️ <b>Панель Адміністратора</b>', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
});

// 1. Модерація та розморожування коштів при відхиленні
bot.action('admin_pub_list', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔');
    const { data: tasks } = await supabase.from('bounties').select('*').eq('status', 'pending_approval');
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Немає нових завдань на модерацію.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    
    await ctx.deleteMessage().catch(()=>{});
    await ctx.reply('📝 <b>Нові завдання:</b>', { parse_mode: 'HTML' });
    for (const t of tasks) {
        await ctx.reply(`<b>${t.title}</b>\nБюджет: $${t.reward}\nЗамовник: <code>${t.creator_id}</code>\nТЗ: ${t.description}`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('✅ Опублікувати', `adm_app_pub_${t.id}`), Markup.button.callback('❌ Відхилити та повернути кошти', `adm_rej_pub_${t.id}`)]])
        });
    }
    await ctx.reply('Навігація:', { ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В адмін-панель', 'admin_main')]]) });
});

bot.action(/adm_app_pub_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await supabase.from('bounties').update({ status: 'open' }).eq('id', id);
    await ctx.editMessageText('✅ <b>Завдання опубліковано на біржі.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action(/adm_rej_pub_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: bounty } = await supabase.from('bounties').select('*').eq('id', id).single();
    
    if (bounty) {
        // Повертаємо кошти з розерву на баланс замовника
        const { data: creator } = await supabase.from('users').select('*').eq('telegram_id', bounty.creator_id).single();
        if (creator) {
            const restoredBalance = creator.balance + bounty.reward;
            const restoredFrozen = Math.max(0, creator.frozen_balance - bounty.reward);
            await supabase.from('users').update({ balance: restoredBalance, frozen_balance: restoredFrozen }).eq('telegram_id', bounty.creator_id);
        }
        await supabase.from('bounties').delete().eq('id', id);
    }
    await ctx.editMessageText('❌ <b>Завдання відхилено. Кошти повернуто замовнику.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

// 2. Перевірка звітів та розподіл комісії
bot.action(/adm_app_rev_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: bounty } = await supabase.from('bounties').select('*').eq('id', id).single();
    
    if (bounty) {
        const netReward = bounty.reward * (1 - COMMISSION_RATE); // 95%
        
        // 1. Знімаємо резерв у замовника
        const { data: creator } = await supabase.from('users').select('*').eq('telegram_id', bounty.creator_id).single();
        if (creator) {
            const newFrozen = Math.max(0, creator.frozen_balance - bounty.reward);
            await supabase.from('users').update({ frozen_balance: newFrozen }).eq('telegram_id', bounty.creator_id);
        }

        // 2. Нараховуємо кошти виконавцю
        const { data: executor } = await supabase.from('users').select('*').eq('telegram_id', bounty.executor_id).single();
        if (executor) {
            const newExecBalance = (executor.balance || 0) + netReward;
            await supabase.from('users').update({ balance: newExecBalance }).eq('telegram_id', bounty.executor_id);
        }

        await supabase.from('bounties').update({ status: 'completed' }).eq('id', id);
        await ctx.editMessageText(`✅ <b>Угоду закрито!</b>\nВиконавцю зараховано: <b>$${netReward.toFixed(2)}</b> (комісія 5% утримана).`, { parse_mode: 'HTML' }).catch(()=>{});
        
        try { 
            await bot.telegram.sendMessage(bounty.executor_id, `🎉 <b>Вашу роботу за завданням «${bounty.title}» схвалено!</b>\nНа ваш баланс зараховано: <b>+$${netReward.toFixed(2)}</b>`, { parse_mode: 'HTML' }); 
        } catch(e){}
    }
});

bot.action(/adm_rej_rev_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: bounty } = await supabase.from('bounties').select('*').eq('id', id).single();
    await supabase.from('bounties').update({ status: 'in_progress' }).eq('id', id);
    await ctx.editMessageText('🔄 <b>Завдання повернуто виконавцю на доопрацювання.</b>', { parse_mode: 'HTML' }).catch(()=>{});
    try { 
        await bot.telegram.sendMessage(bounty.executor_id, `⚠️️ <b>Звіт за завданням «${bounty.title}» відхилено.</b>\nБудь ласка, усуньте зауваження та надішліть новий звіт.`, { parse_mode: 'HTML' }); 
    } catch(e){}
});

// ==========================================
// ЗАПУСК СЕРВЕРА
// ==========================================

bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('🤖 Pry.it (Financial Core) успішно запущено!'))
    .catch(err => console.error('Помилка запуску:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Pry.it Payments API Active.');
});

server.listen(process.env.PORT || 3000, () => {
    console.log(`Сервер працює на порту ${process.env.PORT || 3000}`);
});
