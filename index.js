import http from 'http';
import { Telegraf, Markup, session, Scenes } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_ID = 1038839260; // Твій точний ID

// 🖼 ПОСИЛАННЯ НА БАННЕР (Можеш замінити на свій дизайн з Canva)
const WELCOME_IMAGE = 'https://images.unsplash.com/photo-1614680376573-df3480f0c6ff?q=80&w=1000&auto=format&fit=crop';

// Глобальний обробник помилок (Анти-краш)
bot.catch((err, ctx) => {
    console.error(`[Global Error]:`, err);
});

// --- ГЕНЕРАТОР ГОЛОВНОГО МЕНЮ ---
function getMainMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Знайти баунті', 'list_tasks'), Markup.button.callback('💼 Мій кабінет', 'my_profile')],
        [Markup.button.callback('📂 Мої завдання', 'my_active_tasks'), Markup.button.callback('📜 Історія', 'my_completed_tasks')],
        [Markup.button.callback('➕ Створити баунті', 'create_task')],
        [Markup.button.callback('👑 Адмін-панель', 'admin_main')]
    ]);
}

// --- СЦЕНА СТВОРЕННЯ ЗАВДАННЯ ---
const createTaskWizard = new Scenes.WizardScene(
    'createTaskWizard',
    async (ctx) => {
        await ctx.editMessageText('<blockquote><b>✍️ Крок 1: Назва</b>\n\nВведіть коротку та зрозумілу назву для завдання.</blockquote>\n\n<i>(Напишіть /cancel для скасування)</i>', { parse_mode: 'HTML' }).catch(()=>{});
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.wizard.state.title = ctx.message.text;
        await ctx.reply('<blockquote><b>💰 Крок 2: Нагорода</b>\n\nВведіть суму нагороди в доларах (тільки цифру, наприклад: 50).</blockquote>', { parse_mode: 'HTML' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        const reward = parseFloat(ctx.message.text);
        if (isNaN(reward)) {
            await ctx.reply('❌ Помилка: сума має бути цифрою. Почніть спочатку.', getMainMenu());
            return ctx.scene.leave();
        }
        ctx.wizard.state.reward = reward;
        await ctx.reply('<blockquote><b>📝 Крок 3: Опис</b>\n\nОпишіть, що саме потрібно зробити (вимоги, дедлайни, формат здачі).</blockquote>', { parse_mode: 'HTML' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.wizard.state.description = ctx.message.text;
        const { title, reward, description } = ctx.wizard.state;

        try {
            const { error } = await supabase.from('bounties').insert([{ title, reward, description, status: 'pending_approval', creator_id: ctx.from.id }]);
            if (error) throw error;
            
            await ctx.reply(
                `⏳ <b>Ваше баунті відправлено на модерацію!</b>\n\n<blockquote>💎 <b>${title}</b>\n💰 $${reward}</blockquote>\n\nОчікуйте на підтвердження адміністратором.`, 
                { parse_mode: 'HTML', ...getMainMenu() }
            );

            // Красиве сповіщення адміну
            try { await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Нова заявка на баунті!</b>\n\nВід: @${ctx.from.username || 'Користувача'}\nНазва: <b>${title}</b>\nСума: $${reward}`, { parse_mode: 'HTML' }); } catch (e) {}
        } catch (err) {
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
    await supabase.from('users').upsert({ telegram_id: from.id, username: from.username || null, first_name: from.first_name || 'Користувач' }, { onConflict: 'telegram_id' });
    
    const welcomeText = `👋 Привіт, <b>${from.first_name}</b>!\n\nЛаскаво просимо до <b>Pry.it</b> — елітної платформи для баунті-завдань.\nВиконуй завдання, підвищуй свій ранг та заробляй!\n\n👇 <b>Обери дію в меню:</b>`;
    
    // Відправляємо картинку з меню
    await ctx.replyWithPhoto({ url: WELCOME_IMAGE }, { caption: welcomeText, parse_mode: 'HTML', ...getMainMenu() });
  } catch (err) {
    await ctx.reply('⚠ Меню готове до роботи.', getMainMenu());
  }
});

// Кнопка: Повернення в головне меню (без фото, тільки текст)
bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`🏠 <b>Головне меню</b>\n\n👇 Обери потрібну дію:`, { parse_mode: 'HTML', ...getMainMenu() }).catch(()=>{});
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
            return ctx.editMessageText('📭 <b>Наразі немає відкритих баунті.</b>\nПовертайтеся пізніше!', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'main_menu')]]) }).catch(()=>{});
        }

        await ctx.deleteMessage().catch(()=>{}); 
        await ctx.reply('📋 <b>Доступні завдання на ринку:</b>', { parse_mode: 'HTML' });

        for (const bounty of bounties) {
            await ctx.reply(
                `<blockquote><b>💎 ${bounty.title}</b>\n\n💰 <b>Нагорода:</b> $${bounty.reward}\n📝 <b>Опис:</b> ${bounty.description}</blockquote>`, 
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⚡ Взяти в роботу', `take_${bounty.id}`)]]) }
            );
        }
    } catch (err) {}
});

bot.action('my_active_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: activeTasks } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'in_progress');
        
        if (!activeTasks || activeTasks.length === 0) {
            return ctx.editMessageText('📭 <b>У вас немає активних завдань.</b>\nЧас знайти нове баунті!', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'main_menu')]]) }).catch(()=>{});
        }

        await ctx.deleteMessage().catch(()=>{});
        await ctx.reply('📂 <b>Ваші активні завдання:</b>', { parse_mode: 'HTML' });

        for (const bounty of activeTasks) {
            await ctx.reply(
                `<blockquote><b>💎 ${bounty.title}</b>\n💰 Нагорода: $${bounty.reward}</blockquote>\n\n<i>Щойно закінчите, тисніть кнопку здачі:</i>`, 
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([
                    [Markup.button.callback('📤 Відправити на перевірку', `submit_${bounty.id}`)],
                    [Markup.button.callback('❌ Відмовитися', `cancel_task_${bounty.id}`)]
                ])}
            );
        }
    } catch (err) {}
});

// --- ПРОФІЛЬ ТА ГЕЙМІФІКАЦІЯ ---
bot.action('my_profile', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        let { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
        if (!user) user = { first_name: ctx.from.first_name, telegram_id: ctx.from.id };
        const { data: completedBounties } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'completed');
        
        const count = completedBounties ? completedBounties.length : 0;
        const earnings = completedBounties ? completedBounties.reduce((sum, b) => sum + (b.reward || 0), 0) : 0;

        // Система рангів
        let rank = '🥉 Новачок';
        let nextGoal = 5;
        if (count >= 5) { rank = '🥈 Досвідчений'; nextGoal = 15; }
        if (count >= 15) { rank = '🥇 Профі'; nextGoal = 30; }
        if (count >= 30) { rank = '💎 Легенда Pry.it'; nextGoal = count; } // Максимум

        // Генерація шкали прогресу (10 блоків)
        const progressPercent = Math.min(count / nextGoal, 1);
        const filledBlocks = Math.floor(progressPercent * 10);
        const progressBar = '🟩'.repeat(filledBlocks) + '⬜️'.repeat(10 - filledBlocks);

        const profileText = `
💼 <b>ОСОБИСТИЙ КАБІНЕТ</b>

👤 <b>Користувач:</b> ${user.first_name}
🆔 <b>ID:</b> <code>${user.telegram_id}</code>
🏆 <b>Ваш ранг:</b> ${rank}

📊 <b>Статистика:</b>
 ├ Виконано баунті: <b>${count}</b>
 └ Загальний дохід: <b>$${earnings}</b>

📈 <b>Прогрес до наступного рангу:</b>
[ ${progressBar} ] ${count}/${nextGoal}
        `;

        await ctx.editMessageText(profileText, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В головне меню', 'main_menu')]]) }).catch(()=>{});
    } catch (err) {}
});

// --- ВЗАЄМОДІЯ ІЗ ЗАВДАННЯМИ ---
bot.action(/take_(.+)/, async (ctx) => {
  const bountyId = ctx.match[1];
  try {
    const { data: bounty, error } = await supabase.from('bounties').select('*').eq('id', bountyId).eq('status', 'open').single();
    if (error || !bounty) return ctx.answerCbQuery('❌ Завдання вже забрали або воно недоступне!', {show_alert: true});

    await supabase.from('bounties').update({ status: 'in_progress', executor_id: ctx.from.id }).eq('id', bountyId);
    
    // Красиве спливаюче вікно
    await ctx.answerCbQuery('✅ Ви успішно взяли баунті в роботу!', {show_alert: true});
    
    await ctx.editMessageText(
      `<blockquote><b>💎 ${bounty.title}</b>\n💰 $${bounty.reward}</blockquote>\n\n✅ <b>Завдання закріплено за вами!</b>\nМожете приступати до виконання.`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📤 Відправити на перевірку', `submit_${bounty.id}`)], [Markup.button.callback('🔙 В меню', 'main_menu')]]) }
    ).catch(()=>{});
  } catch (err) { ctx.answerCbQuery('⚠️ Помилка.'); }
});

bot.action(/submit_(.+)/, async (ctx) => {
  const bountyId = ctx.match[1];
  try {
    await supabase.from('bounties').update({ status: 'review' }).eq('id', bountyId).eq('executor_id', ctx.from.id);
    await ctx.answerCbQuery('📤 Звіт надіслано!', {show_alert: true});
    await ctx.editMessageText(`✅ <b>Звіт надіслано модератору.</b>\nОчікуйте на зарахування коштів!`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В головне меню', 'main_menu')]]) }).catch(()=>{});
    try { await bot.telegram.sendMessage(ADMIN_ID, `🔔 <b>Нова робота на перевірку!</b>\nID: <code>${bountyId}</code>`, { parse_mode: 'HTML' }); } catch(e){}
  } catch (err) { ctx.answerCbQuery('⚠️ Помилка.', {show_alert:true}); }
});

bot.action(/cancel_task_(.+)/, async (ctx) => {
    const bountyId = ctx.match[1];
    await supabase.from('bounties').update({ status: 'open', executor_id: null }).eq('id', bountyId).eq('executor_id', ctx.from.id);
    await ctx.answerCbQuery('❌ Ви відмовилися від баунті.', {show_alert: true});
    await ctx.editMessageText('❌ <b>Ви відмовилися від виконання.</b>\nЗавдання повернуто на ринок.', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В головне меню', 'main_menu')]]) }).catch(()=>{});
});


// ==========================================
// 👑 МЕГА АДМІН-ПАНЕЛЬ
// ==========================================

function getAdminMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🆕 Заявки на публікацію', 'admin_pub_list')],
        [Markup.button.callback('🔍 Завдання на перевірці', 'admin_rev_list')],
        [Markup.button.callback('🗑 Управління базою', 'admin_man_list')],
        [Markup.button.callback('🔙 В головне меню', 'main_menu')]
    ]);
}

bot.action('admin_main', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Доступ заборонено. Тільки для адміністратора!', { show_alert: true });
    await ctx.answerCbQuery();
    await ctx.editMessageText('👑 <b>ПАНЕЛЬ АДМІНІСТРАТОРА</b>\n\nОберіть потрібний розділ контролю:', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
});

bot.action('admin_pub_list', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔');
    const { data: tasks } = await supabase.from('bounties').select('*').eq('status', 'pending_approval');
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Немає нових заявок на публікацію.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    
    await ctx.deleteMessage().catch(()=>{});
    await ctx.reply('🆕 <b>Модерація нових завдань:</b>', { parse_mode: 'HTML' });
    for (const t of tasks) {
        await ctx.reply(`<blockquote><b>${t.title}</b>\n💰 $${t.reward}\n📝 ${t.description}</blockquote>`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Опублікувати', `adm_app_pub_${t.id}`), Markup.button.callback('❌ Видалити', `adm_rej_pub_${t.id}`)]
            ])
        });
    }
    await ctx.reply('👇 Навігація:', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В адмінку', 'admin_main')]]) });
});

bot.action(/adm_app_pub_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await supabase.from('bounties').update({ status: 'open' }).eq('id', id);
    await ctx.editMessageText('✅ <b>Завдання успішно опубліковано на ринку!</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action(/adm_rej_pub_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await supabase.from('bounties').delete().eq('id', id);
    await ctx.editMessageText('❌ <b>Завдання відхилено та видалено.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action('admin_rev_list', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔');
    const { data: tasks } = await supabase.from('bounties').select('*').eq('status', 'review');
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Немає завдань на перевірці.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    
    await ctx.deleteMessage().catch(()=>{});
    await ctx.reply('🔍 <b>Звіти виконавців на перевірку:</b>', { parse_mode: 'HTML' });
    for (const t of tasks) {
        await ctx.reply(`<blockquote><b>💎 ${t.title}</b>\n👤 Виконавець: <code>${t.executor_id}</code></blockquote>`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💰 Підтвердити та Оплатити', `adm_app_rev_${t.id}`)],
                [Markup.button.callback('🔄 На доопрацювання', `adm_rej_rev_${t.id}`)]
            ])
        });
    }
    await ctx.reply('👇 Навігація:', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В адмінку', 'admin_main')]]) });
});

bot.action(/adm_app_rev_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: bounty } = await supabase.from('bounties').select('*').eq('id', id).single();
    await supabase.from('bounties').update({ status: 'completed' }).eq('id', id);
    await ctx.editMessageText('🎉 <b>Виконання зараховано!</b>', { parse_mode: 'HTML' }).catch(()=>{});
    try { await bot.telegram.sendMessage(bounty.executor_id, `🎉 Вашу роботу <b>${bounty.title}</b> схвалено!\nНагорода <b>$${bounty.reward}</b> зарахована.`, { parse_mode: 'HTML' }); } catch(e){}
});

bot.action(/adm_rej_rev_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    const { data: bounty } = await supabase.from('bounties').select('*').eq('id', id).single();
    await supabase.from('bounties').update({ status: 'in_progress' }).eq('id', id);
    await ctx.editMessageText('🔄 <b>Повернуто на доопрацювання.</b>', { parse_mode: 'HTML' }).catch(()=>{});
    try { await bot.telegram.sendMessage(bounty.executor_id, `⚠️ Ваша робота <b>${bounty.title}</b> відхилена адміном. Будь ласка, переробіть!`, { parse_mode: 'HTML' }); } catch(e){}
});

bot.action('admin_man_list', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔');
    const { data: tasks } = await supabase.from('bounties').select('*').in('status', ['open', 'in_progress']);
    if (!tasks || tasks.length === 0) return ctx.editMessageText('📭 Немає активних завдань.', { parse_mode: 'HTML', ...getAdminMenu() }).catch(()=>{});
    
    await ctx.deleteMessage().catch(()=>{});
    await ctx.reply('🗑 <b>Управління активними завданнями:</b>', { parse_mode: 'HTML' });
    for (const t of tasks) {
        await ctx.reply(`🔹 <b>${t.title}</b> (Статус: ${t.status})`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('🗑 Примусово видалити', `adm_del_task_${t.id}`)]])
        });
    }
    await ctx.reply('👇 Навігація:', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В адмінку', 'admin_main')]]) });
});

bot.action(/adm_del_task_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await supabase.from('bounties').delete().eq('id', id);
    await ctx.editMessageText('🗑 <b>Завдання знищено.</b>', { parse_mode: 'HTML' }).catch(()=>{});
});

// ==========================================
// ЗАПУСК СЕРВЕРА
// ==========================================
bot.launch(() => console.log('🤖 Бот Pry.it (PREMIUM VERSION) успішно запущено!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Pry.it Premium Bot is running!');
}).listen(process.env.PORT || 3000);
