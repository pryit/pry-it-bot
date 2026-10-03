import http from 'http';
import { Telegraf, Markup, session, Scenes } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_ID = 1038839260; 

// --- СИСТЕМА БЕЗОПАСНОСТИ ТА ЛОГУВАННЯ ---
bot.catch((err, ctx) => {
    console.error(`[System Error]:`, err);
    try {
        ctx.reply('⚠️ Сталася системна помилка. Будь ласка, спробуйте пізніше або поверніться в меню /start.').catch(()=>{});
    } catch(e) {}
});

// --- ДИНАМІЧНЕ ІНТЕРФЕЙС: ГОЛОВНЕ МЕНЮ ---
// Тепер бот перевіряє ID. Кнопка Адміна з'явиться ТІЛЬКИ у тебе.
function getMainMenu(userId) {
    const buttons = [
        [Markup.button.callback('💼 Мій кабінет', 'my_profile'), Markup.button.callback('📋 Біржа завдань', 'list_tasks')],
        [Markup.button.callback('📂 Мої завдання', 'my_active_tasks'), Markup.button.callback('📊 Історія', 'my_completed_tasks')],
        [Markup.button.callback('➕ Створити завдання', 'create_task')]
    ];
    
    // Якщо меню викликаєш ти (Адмін), додаємо секретну кнопку
    if (userId === ADMIN_ID) {
        buttons.push([Markup.button.callback('⚙️ Панель управління (Адмін)', 'admin_main')]);
    }
    
    return Markup.inlineKeyboard(buttons);
}

const backButton = Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'main_menu')]]);

// --- БІЗНЕС-ЛОГІКА: СТВОРЕННЯ ЗАВДАННЯ (WIZARD) ---
const createTaskWizard = new Scenes.WizardScene(
    'createTaskWizard',
    async (ctx) => {
        await ctx.editMessageText(
            '<b>Створення нового завдання (1/3)</b>\n\nВведіть коротку та чітку назву завдання.\n<i>(Надішліть /cancel для скасування)</i>', 
            { parse_mode: 'HTML' }
        ).catch(async () => {
            await ctx.reply('<b>Створення нового завдання (1/3)</b>\n\nВведіть коротку та чітку назву завдання.', { parse_mode: 'HTML' });
        });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.message.text === '/cancel') return cancelWizard(ctx);
        ctx.wizard.state.title = ctx.message.text;
        await ctx.reply('<b>Бюджет завдання (2/3)</b>\n\nВведіть суму винагороди у доларах США (лише число, наприклад: 50 або 150):', { parse_mode: 'HTML' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.message.text === '/cancel') return cancelWizard(ctx);
        const reward = parseFloat(ctx.message.text);
        if (isNaN(reward)) {
            await ctx.reply('❌ Помилка: бюджет має бути вказаний числом. Операцію скасовано.', getMainMenu(ctx.from.id));
            return ctx.scene.leave();
        }
        ctx.wizard.state.reward = reward;
        await ctx.reply('<b>Технічне завдання (3/3)</b>\n\nОпишіть детальні вимоги, умови виконання та критерії прийомки роботи:', { parse_mode: 'HTML' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.message.text === '/cancel') return cancelWizard(ctx);
        ctx.wizard.state.description = ctx.message.text;
        const { title, reward, description } = ctx.wizard.state;

        try {
            const { error } = await supabase.from('bounties').insert([{ 
                title, reward, description, status: 'pending_approval', creator_id: ctx.from.id 
            }]);
            
            if (error) throw error;
            
            await ctx.reply(
                `✅ <b>Завдання успішно сформовано</b>\n\nСтатус: <i>Очікує модерації</i>\nПісля перевірки адміністратором воно з'явиться на біржі.`, 
                { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) }
            );

            try { 
                await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Система: Нова заявка</b>\n\nКлієнт: <code>${ctx.from.id}</code>\nЗавдання: ${title}\nБюджет: $${reward}`, { parse_mode: 'HTML' }); 
            } catch (e) {}
            
        } catch (err) {
            await ctx.reply('⚠️ Помилка бази даних. Спробуйте пізніше.', backButton);
        }
        return ctx.scene.leave();
    }
);

async function cancelWizard(ctx) {
    await ctx.reply('❌ Створення завдання скасовано.', getMainMenu(ctx.from.id));
    return ctx.scene.leave();
}

const stage = new Scenes.Stage([createTaskWizard]);
bot.use(session());
bot.use(stage.middleware());

// --- СТАРТ ТА ІНТЕРФЕЙС ---
bot.start(async (ctx) => {
    const from = ctx.from;
    try {
        await supabase.from('users').upsert(
            { telegram_id: from.id, username: from.username || null, first_name: from.first_name || 'Користувач' }, 
            { onConflict: 'telegram_id' }
        );
        
        await ctx.reply(
            `Платформа <b>Pry.it</b>\n\nСистема управління завданнями та виплатами. Оберіть необхідний розділ меню для продовження.`, 
            { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) }
        );
    } catch (err) {
        await ctx.reply('Система готова до роботи.', getMainMenu(ctx.from.id));
    }
});

bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `Платформа <b>Pry.it</b>\n\nСистема управління завданнями та виплатами. Оберіть необхідний розділ меню для продовження.`, 
        { parse_mode: 'HTML', ...getMainMenu(ctx.from.id) }
    ).catch(()=>{});
});

bot.action('create_task', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('createTaskWizard');
});

// --- ПРОФІЛЬ ---
bot.action('my_profile', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
        const { data: completedBounties } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'completed');
        
        const count = completedBounties ? completedBounties.length : 0;
        const earnings = completedBounties ? completedBounties.reduce((sum, b) => sum + (b.reward || 0), 0) : 0;

        const profileText = `
💼 <b>Особистий кабінет</b>

Користувач: <b>${user?.first_name || ctx.from.first_name}</b>
Системний ID: <code>${ctx.from.id}</code>

📊 <b>Статистика:</b>
Успішних угод: <b>${count}</b>
Загальний дохід: <b>$${earnings}</b>
        `;
        await ctx.editMessageText(profileText, { parse_mode: 'HTML', ...backButton }).catch(()=>{});
    } catch (err) {
        await ctx.answerCbQuery('Помилка завантаження профілю', {show_alert:true});
    }
});

// --- БІРЖА ТА РОБОТА З ЗАВДАННЯМИ ---
bot.action('list_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: bounties } = await supabase.from('bounties').select('*').eq('status', 'open');
        
        if (!bounties || bounties.length === 0) {
            return ctx.editMessageText('📭 <b>Біржа порожня.</b>\nНаразі немає відкритих завдань для виконання.', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
        }

        await ctx.deleteMessage().catch(()=>{}); 
        await ctx.reply('📋 <b>Доступні завдання на біржі:</b>', { parse_mode: 'HTML' });

        for (const bounty of bounties) {
            await ctx.reply(
                `<b>${bounty.title}</b>\n\nБюджет: <b>$${bounty.reward}</b>\nТЗ: ${bounty.description}`, 
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
            return ctx.editMessageText('📭 <b>Немає активних завдань.</b>\nВи не маєте завдань у процесі виконання.', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
        }

        await ctx.deleteMessage().catch(()=>{});
        await ctx.reply('📂 <b>Ваші завдання в роботі:</b>', { parse_mode: 'HTML' });

        for (const bounty of activeTasks) {
            await ctx.reply(
                `<b>${bounty.title}</b>\nБюджет: $${bounty.reward}\n\n<i>Для передачі результатів натисніть кнопку нижче:</i>`, 
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Здати на перевірку', `submit_${bounty.id}`)],
                    [Markup.button.callback('❌ Відмовитися', `cancel_task_${bounty.id}`)]
                ])}
            );
        }
    } catch (err) {}
});

bot.action('my_completed_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: completedTasks } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'completed');
        
        if (!completedTasks || completedTasks.length === 0) {
            return ctx.editMessageText('📭 <b>Історія порожня.</b>\nУ вас немає завершених завдань.', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
        }

        await ctx.deleteMessage().catch(()=>{});
        await ctx.reply('📊 <b>Історія успішних угод:</b>', { parse_mode: 'HTML' });

        for (const bounty of completedTasks) {
            await ctx.reply(`✅ <b>${bounty.title}</b>\nОплачено: <b>$${bounty.reward}</b>`, { parse_mode: 'HTML' });
        }
        await ctx.reply('Навігація:', backButton);
    } catch (err) {}
});

// --- ЕКШЕНИ ЗАВДАНЬ ---
bot.action(/take_(.+)/, async (ctx) => {
  const bountyId = ctx.match[1];
  try {
    const { data: bounty, error } = await supabase.from('bounties').select('*').eq('id', bountyId).eq('status', 'open').single();
    if (error || !bounty) return ctx.answerCbQuery('❌ Завдання вже не актуальне', {show_alert: true});

    await supabase.from('bounties').update({ status: 'in_progress', executor_id: ctx.from.id }).eq('id', bountyId);
    
    await ctx.answerCbQuery('✅ Завдання успішно закріплено за вами');
    await ctx.editMessageText(
      `<b>${bounty.title}</b>\nБюджет: $${bounty.reward}\n\n✅ <b>Статус:</b> В роботі.\nВиконайте ТЗ та надішліть звіт через систему.`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Здати на перевірку', `submit_${bounty.id}`)], [Markup.button.callback('🔙 В меню', 'main_menu')]]) }
    ).catch(()=>{});
  } catch (err) { ctx.answerCbQuery('Помилка системи', {show_alert:true}); }
});

bot.action(/submit_(.+)/, async (ctx) => {
  const bountyId = ctx.match[1];
  try {
    await supabase.from('bounties').update({ status: 'review' }).eq('id', bountyId).eq('executor_id', ctx.from.id);
    await ctx.answerCbQuery('Звіт передано');
    await ctx.editMessageText(`✅ <b>Звіт успішно передано.</b>\nОчікуйте рішення адміністратора.`, { parse_mode: 'HTML', ...backButton }).catch(()=>{});
    try { await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Система: Звіт на перевірку</b>\nID завдання: <code>${bountyId}</code>`, { parse_mode: 'HTML' }); } catch(e){}
  } catch (err) { ctx.answerCbQuery('Помилка', {show_alert:true}); }
});

bot.action(/cancel_task_(.+)/, async (ctx) => {
    const bountyId = ctx.match[1];
    await supabase.from('bounties').update({ status: 'open', executor_id: null }).eq('id', bountyId).eq('executor_id', ctx.from.id);
    await ctx.answerCbQuery('Ви відмовилися від завдання');
    await ctx.editMessageText('❌ <b>Відмова зафіксована.</b>\nЗавдання повернуто на біржу.', { parse_mode: 'HTML', ...backButton }).catch(()=>{});
});


// ==========================================
// ⚙️ ПАНЕЛЬ УПРАВЛІННЯ (АДМІН)
// ==========================================

function getAdminMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📝 Модерація заявок', 'admin_pub_list')],
        [Markup.button.callback('🔍 Перевірка звітів', 'admin_rev_list')],
        [Markup.button.callback('🗑 Управління базою', 'admin_man_list')],
        [Markup.button.callback('🔙 До головного меню', 'main_menu')]
    ]);
}

bot.action('admin_main', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Відмовлено в доступі. Рівень: Адміністратор.', { show_alert: true });
    await ctx.answerCbQuery();
    await ctx.editMessageText('⚙️ <b>Системна Панель Управління</b>\n\nОберіть директорію для роботи:', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
});

bot.action('admin_pub_list', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔');
    const { data: tasks } = await supabase.from('bounties').select('*').eq('status', 'pending_approval');
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 <b>Черга порожня.</b>\nНемає нових завдань для модерації.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    
    await ctx.deleteMessage().catch(()=>{});
    await ctx.reply('📝 <b>Модерація нових завдань:</b>', { parse_mode: 'HTML' });
    for (const t of tasks) {
        await ctx.reply(`<b>${t.title}</b>\nБюджет: $${t.reward}\nID Клієнта: <code>${t.creator_id}</code>\nТЗ: ${t.description}`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('✅ Опублікувати', `adm_app_pub_${t.id}`), Markup.button.callback('❌ Відхилити', `adm_rej_pub_${t.id}`)]])
        });
    }
    await ctx.reply('Навігація:', { ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В адмін-панель', 'admin_main')]]) });
});

bot.action(/adm_app_pub_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await supabase.from('bounties').update({ status: 'open' }).eq('id', id);
    await ctx.editMessageText('✅ <b>Опубліковано.</b> Завдання доступне на біржі.', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action(/adm_rej_pub_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await supabase.from('bounties').delete().eq('id', id);
    await ctx.editMessageText('❌ <b>Завдання видалено з системи.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action('admin_rev_list', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔');
    const { data: tasks } = await supabase.from('bounties').select('*').eq('status', 'review');
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 <b>Черга порожня.</b>\nНемає звітів на перевірці.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    
    await ctx.deleteMessage().catch(()=>{});
    await ctx.reply('🔍 <b>Аудит виконаних завдань:</b>', { parse_mode: 'HTML' });
    for (const t of tasks) {
        await ctx.reply(`<b>${t.title}</b>\nID Виконавця: <code>${t.executor_id}</code>`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Схвалити та Оплатити', `adm_app_rev_${t.id}`)],
                [Markup.button.callback('🔄 Повернути на доопрацювання', `adm_rej_rev_${t.id}`)]
            ])
        });
    }
    await ctx.reply('Навігація:', { ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В адмін-панель', 'admin_main')]]) });
});

bot.action(/adm_app_rev_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: bounty } = await supabase.from('bounties').select('*').eq('id', id).single();
    await supabase.from('bounties').update({ status: 'completed' }).eq('id', id);
    await ctx.editMessageText('✅ <b>Завдання закрито, виплату підтверджено.</b>', { parse_mode: 'HTML' }).catch(()=>{});
    try { await bot.telegram.sendMessage(bounty.executor_id, `✅ <b>Система:</b> Вашу роботу <b>${bounty.title}</b> схвалено.\nКошти ($${bounty.reward}) зараховано до статистики.`, { parse_mode: 'HTML' }); } catch(e){}
});

bot.action(/adm_rej_rev_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: bounty } = await supabase.from('bounties').select('*').eq('id', id).single();
    await supabase.from('bounties').update({ status: 'in_progress' }).eq('id', id);
    await ctx.editMessageText('🔄 <b>Завдання повернуто виконавцю.</b>', { parse_mode: 'HTML' }).catch(()=>{});
    try { await bot.telegram.sendMessage(bounty.executor_id, `⚠️ <b>Система:</b> Вашу роботу <b>${bounty.title}</b> не прийнято.\nБудь ласка, доопрацюйте технічне завдання.`, { parse_mode: 'HTML' }); } catch(e){}
});

bot.action('admin_man_list', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔');
    const { data: tasks } = await supabase.from('bounties').select('*').in('status', ['open', 'in_progress']);
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 <b>База порожня.</b>\nАктивних завдань не знайдено.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    
    await ctx.deleteMessage().catch(()=>{});
    await ctx.reply('🗑 <b>Управління активними завданнями бази:</b>', { parse_mode: 'HTML' });
    for (const t of tasks) {
        await ctx.reply(`<b>${t.title}</b> (Статус: ${t.status})`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('🗑 Примусово видалити', `adm_del_task_${t.id}`)]])
        });
    }
    await ctx.reply('Навігація:', { ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В адмін-панель', 'admin_main')]]) });
});

bot.action(/adm_del_task_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await supabase.from('bounties').delete().eq('id', id);
    await ctx.editMessageText('🗑 <b>Об\'єкт успішно знищено.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

// ==========================================
// ЗАПУСК СЕРВЕРА
// ==========================================

bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('🤖 Pry.it (Enterprise Core) успішно запущено!'))
    .catch(err => console.error('Помилка запуску:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Pry.it API is active.');
});

server.listen(process.env.PORT || 3000, () => {
    console.log(`Сервер працює на порту ${process.env.PORT || 3000}`);
});
