import http from 'http';
import { Telegraf, Markup, session, Scenes } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_ID = 1038839260; 

// Глобальный обработчик ошибок (чтобы бот никогда не зависал и не падал)
bot.catch((err, ctx) => {
    console.error(`[Global Error] for ${ctx.updateType}:`, err);
});

// --- ГЕНЕРАТОР ГЛАВНОГО МЕНЮ ---
function getMainMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📋 Доступні завдання', 'list_tasks'), Markup.button.callback('📂 Мої в роботі', 'my_active_tasks')],
        [Markup.button.callback('➕ Створити завдання', 'create_task'), Markup.button.callback('📜 Історія', 'my_completed_tasks')],
        [Markup.button.callback('💼 Мій профіль', 'my_profile')],
        [Markup.button.callback('👑 Адмін-панель', 'admin_main')]
    ]);
}

// --- СЦЕНА СТВОРЕННЯ ЗАВДАННЯ ---
const createTaskWizard = new Scenes.WizardScene(
    'createTaskWizard',
    async (ctx) => {
        await ctx.reply('✍️ <b>Введіть коротку назву для завдання:</b>\n<i>(або напишіть /cancel для відміни)</i>', { parse_mode: 'HTML' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.wizard.state.title = ctx.message.text;
        await ctx.reply('💰 <b>Введіть суму нагороди в доларах:</b>\n<i>(Тільки цифру, наприклад: 50)</i>', { parse_mode: 'HTML' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        const reward = parseFloat(ctx.message.text);
        if (isNaN(reward)) {
            await ctx.reply('❌ Помилка: сума має бути цифрою. Почніть спочатку.', getMainMenu());
            return ctx.scene.leave();
        }
        ctx.wizard.state.reward = reward;
        await ctx.reply('📝 <b>Тепер введіть детальний опис завдання:</b>', { parse_mode: 'HTML' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.wizard.state.description = ctx.message.text;
        const { title, reward, description } = ctx.wizard.state;

        try {
            // Зберігаємо зі статусом pending_approval (очікує модерації)
            const { error } = await supabase
                .from('bounties')
                .insert([{ title, reward, description, status: 'pending_approval', creator_id: ctx.from.id }]);

            if (error) throw error;
            await ctx.reply(
                `⏳ <b>Завдання створено!</b>\n\nВоно відправлено адміністратору на перевірку. Щойно його схвалять, воно з'явиться у загальному списку.`, 
                { parse_mode: 'HTML', ...getMainMenu() }
            );

            // Сповіщення адміну
            try {
                await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Нове завдання на модерацію!</b>\nВід: @${ctx.from.username || ctx.from.first_name}`, { parse_mode: 'HTML' });
            } catch (e) { console.error('Не вдалося відправити адміну сповіщення'); }

        } catch (err) {
            console.error('Помилка створення:', err);
            await ctx.reply('⚠️ Системна помилка збереження.', getMainMenu());
        }
        return ctx.scene.leave();
    }
);

createTaskWizard.use(async (ctx, next) => {
    if (ctx.message && ctx.message.text === '/cancel') {
        await ctx.reply('❌ Створення скасовано.', getMainMenu());
        return ctx.scene.leave();
    }
    return next();
});

const stage = new Scenes.Stage([createTaskWizard]);
bot.use(session());
bot.use(stage.middleware());

// --- СТАРТ ТА РЕЄСТРАЦІЯ ---
bot.start(async (ctx) => {
  const from = ctx.from;
  try {
    await supabase.from('users').upsert(
        { telegram_id: from.id, username: from.username || null, first_name: from.first_name || 'Користувач' }, 
        { onConflict: 'telegram_id' }
    );
    
    await ctx.reply(
        `👋 Привіт, <b>${from.first_name}</b>!\n\nЯ <b>Pry.it</b> — твій персональний менеджер баунті-завдань.\n\n👇 Обери потрібну дію:`, 
        { parse_mode: 'HTML', ...getMainMenu() }
    );
  } catch (err) {
    await ctx.reply('⚠️️ Вітаю! Меню готове до роботи.', getMainMenu());
  }
});

// Кнопка: Повернення в головне меню
bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`🏠 <b>Головне меню</b>\n👇 Обери потрібну дію:`, { parse_mode: 'HTML', ...getMainMenu() }).catch(()=>{});
});

// --- СТВОРЕННЯ ЗАВДАННЯ ---
bot.action('create_task', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('createTaskWizard');
});

// --- СПИСКИ ЗАВДАНЬ ДЛЯ КОРИСТУВАЧА ---
bot.action('list_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: bounties, error } = await supabase.from('bounties').select('*').eq('status', 'open');
        if (error) throw error;
        
        if (!bounties || bounties.length === 0) {
            return ctx.editMessageText('📭 Наразі немає відкритих завдань.', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'main_menu')]]) }).catch(()=>{});
        }

        await ctx.deleteMessage().catch(()=>{}); // Видаляємо старе повідомлення щоб не спамити
        await ctx.reply('📋 <b>Список доступних завдань:</b>', { parse_mode: 'HTML' });

        for (const bounty of bounties) {
            await ctx.reply(
                `🔹 <b>${bounty.title}</b>\n\n💰 <b>Нагорода:</b> $${bounty.reward}\n📝 <b>Опис:</b> ${bounty.description}`, 
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🛠 Взяти в роботу', `take_${bounty.id}`)]]) }
            );
        }
    } catch (err) {
        await ctx.reply('⚠️ Не вдалося завантажити список.');
    }
});

bot.action('my_active_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: activeTasks } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'in_progress');
        
        if (!activeTasks || activeTasks.length === 0) {
            return ctx.editMessageText('📭 У вас немає завдань у роботі.', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'main_menu')]]) }).catch(()=>{});
        }

        await ctx.deleteMessage().catch(()=>{});
        await ctx.reply('📂 <b>Ваші активні завдання:</b>', { parse_mode: 'HTML' });

        for (const bounty of activeTasks) {
            await ctx.reply(
                `🔹 <b>${bounty.title}</b>\n💰 Нагорода: $${bounty.reward}`, 
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([
                    [Markup.button.callback('📤 Здати на перевірку', `submit_${bounty.id}`)],
                    [Markup.button.callback('❌ Відмовитися', `cancel_task_${bounty.id}`)]
                ])}
            );
        }
    } catch (err) {}
});

// --- ПРОФІЛЬ ---
bot.action('my_profile', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        let { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
        if (!user) user = { first_name: ctx.from.first_name, telegram_id: ctx.from.id };
        const { data: completedBounties } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'completed');
        const completedCount = completedBounties ? completedBounties.length : 0;
        const totalEarnings = completedBounties ? completedBounties.reduce((sum, b) => sum + (b.reward || 0), 0) : 0;

        await ctx.editMessageText(
            `📁 <b>Особистий кабінет</b>\n\n👤 Ім'я: <b>${user.first_name}</b>\n🆔 ID: <code>${user.telegram_id}</code>\n\n📊 <b>Статистика:</b>\n✅ Виконано: <b>${completedCount}</b>\n💰 Зароблено: <b>$${totalEarnings}</b>`, 
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В головне меню', 'main_menu')]]) }
        ).catch(()=>{});
    } catch (err) {}
});

// --- ВЗАЄМОДІЯ ІЗ ЗАВДАННЯМИ ---
bot.action(/take_(.+)/, async (ctx) => {
  const bountyId = ctx.match[1];
  try {
    const { data: bounty, error } = await supabase.from('bounties').select('*').eq('id', bountyId).eq('status', 'open').single();
    if (error || !bounty) return ctx.answerCbQuery('❌ Завдання вже зайняте або видалене!', {show_alert: true});

    await supabase.from('bounties').update({ status: 'in_progress', executor_id: ctx.from.id }).eq('id', bountyId);
    await ctx.editMessageText(
      `✅ <b>Ви взяли завдання в роботу!</b>\n\n🔹 <b>${bounty.title}</b>\n💰 $${bounty.reward}\n\n👇 Коли закінчите, натисніть кнопку:`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📤 Здати на перевірку', `submit_${bounty.id}`)], [Markup.button.callback('❌ Відмовитися', `cancel_task_${bounty.id}`)]]) }
    ).catch(()=>{});
  } catch (err) { ctx.answerCbQuery('⚠️ Помилка.'); }
});

bot.action(/submit_(.+)/, async (ctx) => {
  const bountyId = ctx.match[1];
  try {
    await supabase.from('bounties').update({ status: 'review' }).eq('id', bountyId).eq('executor_id', ctx.from.id);
    await ctx.editMessageText(`📤 <b>Звіт надіслано!</b>\nОчікуйте перевірки адміністратором.`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В головне меню', 'main_menu')]]) }).catch(()=>{});
    try { await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Нова робота на перевірку!</b>\nID Завдання: ${bountyId}`, { parse_mode: 'HTML' }); } catch(e){}
  } catch (err) { ctx.answerCbQuery('⚠️ Помилка.', {show_alert:true}); }
});

bot.action(/cancel_task_(.+)/, async (ctx) => {
    const bountyId = ctx.match[1];
    await supabase.from('bounties').update({ status: 'open', executor_id: null }).eq('id', bountyId).eq('executor_id', ctx.from.id);
    await ctx.editMessageText('❌ Ви відмовилися від завдання.', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В головне меню', 'main_menu')]]) }).catch(()=>{});
});


// ==========================================
// 👑 МЕГА АДМІН-ПАНЕЛЬ
// ==========================================

function getAdminMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🆕 Заявки на публікацію', 'admin_pub_list')],
        [Markup.button.callback('🔍 Завдання на перевірці', 'admin_rev_list')],
        [Markup.button.callback('🗑 Управління (Видалення)', 'admin_man_list')],
        [Markup.button.callback('🔙 В головне меню', 'main_menu')]
    ]);
}

bot.action('admin_main', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Доступ заборонено!', { show_alert: true });
    await ctx.answerCbQuery();
    await ctx.editMessageText('👑 <b>Панель Адміністратора</b>\nОберіть розділ:', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
});

// 1. Заявки на публікацію (Премодерація)
bot.action('admin_pub_list', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔');
    const { data: tasks } = await supabase.from('bounties').select('*').eq('status', 'pending_approval');
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Немає нових заявок на публікацію.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    
    await ctx.deleteMessage().catch(()=>{});
    await ctx.reply('🆕 <b>Нові завдання (очікують схвалення):</b>', { parse_mode: 'HTML' });
    for (const t of tasks) {
        await ctx.reply(`🔹 <b>${t.title}</b>\n💰 $${t.reward}\n📝 ${t.description}`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Опублікувати', `adm_app_pub_${t.id}`), Markup.button.callback('❌ Відхилити', `adm_rej_pub_${t.id}`)]
            ])
        });
    }
    await ctx.reply('👇 Повернутися:', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В адмін-меню', 'admin_main')]]) });
});

bot.action(/adm_app_pub_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await supabase.from('bounties').update({ status: 'open' }).eq('id', id);
    await ctx.editMessageText('✅ <b>Завдання опубліковано!</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action(/adm_rej_pub_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await supabase.from('bounties').delete().eq('id', id);
    await ctx.editMessageText('❌ <b>Завдання видалено/відхилено.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

// 2. Перевірка виконаних завдань
bot.action('admin_rev_list', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔');
    const { data: tasks } = await supabase.from('bounties').select('*').eq('status', 'review');
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Немає завдань на перевірці.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    
    await ctx.deleteMessage().catch(()=>{});
    await ctx.reply('🔍 <b>Завдання, які здали на перевірку:</b>', { parse_mode: 'HTML' });
    for (const t of tasks) {
        await ctx.reply(`🔹 <b>${t.title}</b>\nВиконавець ID: <code>${t.executor_id}</code>`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Підтвердити виконання', `adm_app_rev_${t.id}`)],
                [Markup.button.callback('🔄 Повернути в роботу', `adm_rej_rev_${t.id}`)]
            ])
        });
    }
    await ctx.reply('👇 Повернутися:', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В адмін-меню', 'admin_main')]]) });
});

bot.action(/adm_app_rev_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: bounty } = await supabase.from('bounties').select('*').eq('id', id).single();
    await supabase.from('bounties').update({ status: 'completed' }).eq('id', id);
    await ctx.editMessageText('🎉 <b>Виконання підтверджено!</b>', { parse_mode: 'HTML' }).catch(()=>{});
    try { await bot.telegram.sendMessage(bounty.executor_id, `🎉 Вашу роботу за завданням <b>${bounty.title}</b> схвалено!`, { parse_mode: 'HTML' }); } catch(e){}
});

bot.action(/adm_rej_rev_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: bounty } = await supabase.from('bounties').select('*').eq('id', id).single();
    await supabase.from('bounties').update({ status: 'in_progress' }).eq('id', id);
    await ctx.editMessageText('🔄 <b>Завдання повернуто виконавцю на доопрацювання.</b>', { parse_mode: 'HTML' }).catch(()=>{});
    try { await bot.telegram.sendMessage(bounty.executor_id, `⚠️ Ваша робота <b>${bounty.title}</b> відхилена адміном. Доопрацюйте!`, { parse_mode: 'HTML' }); } catch(e){}
});

// 3. Управління (Примусове видалення)
bot.action('admin_man_list', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔');
    // Беремо всі відкриті та в роботі
    const { data: tasks } = await supabase.from('bounties').select('*').in('status', ['open', 'in_progress']);
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Немає активних завдань.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    
    await ctx.deleteMessage().catch(()=>{});
    await ctx.reply('🗑 <b>Управління активними завданнями:</b>', { parse_mode: 'HTML' });
    for (const t of tasks) {
        await ctx.reply(`🔹 <b>${t.title}</b> (Статус: ${t.status})`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('🗑 Видалити завдання', `adm_del_task_${t.id}`)]])
        });
    }
    await ctx.reply('👇 Повернутися:', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В адмін-меню', 'admin_main')]]) });
});

bot.action(/adm_del_task_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await supabase.from('bounties').delete().eq('id', id);
    await ctx.editMessageText('🗑 <b>Завдання назавжди видалено з бази.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

// ==========================================
// ЗАПУСК СЕРВЕРА
// ==========================================
bot.launch(() => console.log('🤖 Бот Pry.it успішно запущено (Clean & Secure Version)!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running securely!');
}).listen(process.env.PORT || 3000);
