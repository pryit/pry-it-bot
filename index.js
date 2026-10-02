import http from 'http';
import { Telegraf, Markup, session, Scenes } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// 👑 ВСТАВ СВІЙ РЕАЛЬНИЙ TELEGRAM ID ТУТ
const ADMIN_ID = 1038839260; // Заміни на свій ID!

const createTaskWizard = new Scenes.WizardScene(
    'createTaskWizard',
    async (ctx) => {
        await ctx.reply('✍️ Введіть коротку назву для нового завдання (або напишіть /cancel для відміни):');
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.wizard.state.title = ctx.message.text;
        await ctx.reply('💰 Введіть суму нагороди в доларах (тільки цифру, наприклад: 50 або 100):');
        return ctx.wizard.next();
    },
    async (ctx) => {
        const reward = parseFloat(ctx.message.text);
        if (isNaN(reward)) {
            await ctx.reply('❌ Помилка: нагорода має бути цифрою. Спробуйте створити завдання з початку.');
            return ctx.scene.leave();
        }
        ctx.wizard.state.reward = reward;
        await ctx.reply('📝 Тепер введіть детальний опис завдання:');
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.wizard.state.description = ctx.message.text;
        const { title, reward, description } = ctx.wizard.state;

        try {
            const { error } = await supabase
                .from('bounties')
                .insert([{ title, reward, description, status: 'open', creator_id: ctx.from.id }]);

            if (error) throw error;
            await ctx.reply(`✅ Завдання "*${title}*" на суму $${reward} успішно створено!`, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error('Помилка створення завдання:', err);
            await ctx.reply('⚠️ Системна помилка збереження.');
        }
        return ctx.scene.leave();
    }
);

createTaskWizard.use(async (ctx, next) => {
    if (ctx.message && ctx.message.text === '/cancel') {
        await ctx.reply('❌ Створення завдання скасовано.');
        return ctx.scene.leave();
    }
    return next();
});

const stage = new Scenes.Stage([createTaskWizard]);
bot.use(session());
bot.use(stage.middleware());

bot.start(async (ctx) => {
  const from = ctx.from;
  try {
    // Безпечний апдейт або вставка користувача
    await supabase
      .from('users')
      .upsert({ 
        telegram_id: from.id, 
        username: from.username || null, 
        first_name: from.first_name || 'Користувач' 
      }, { onConflict: 'telegram_id' });
    
    await ctx.reply(
        `👋 Привіт, ${from.first_name}! Я Pry.it — твій менеджер баунті-завдань.\nВаш профіль успішно зареєстровано в базі!\n\nОбери дію в меню нижче:`, 
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📋 Список доступних завдань', callback_data: 'list_tasks' }],
                    [{ text: '📂 Мої завдання в роботі', callback_data: 'my_active_tasks' }],
                    [{ text: '📜 Історія виконаних', callback_data: 'my_completed_tasks' }],
                    [{ text: '➕ Створити нове завдання', callback_data: 'create_task' }],
                    [{ text: '💼 Мій профіль', callback_data: 'my_profile' }],
                    [{ text: '👑 Адмін-панель (Перевірка)', callback_data: 'admin_reviews' }]
                ]
            }
        }
    );
  } catch (err) {
    console.error('Помилка /start:', err);
    await ctx.reply('⚠️ Вітаю! Меню готове до роботи.');
  }
});

bot.command('bounties', async (ctx) => {
  try {
    const { data: bounties, error } = await supabase.from('bounties').select('*').eq('status', 'open');
    if (error) throw error;
    if (!bounties || bounties.length === 0) return ctx.reply('Наразі немає відкритих завдань.');

    for (const bounty of bounties) {
      await ctx.reply(`🔹 *${bounty.title}*\n💰 Нагорода: **$${bounty.reward}**\n📝 Опис: ${bounty.description}\n🆔 ID: \`${bounty.id}\``, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🛠 Взяти в роботу', `take_${bounty.id}`)]])
      });
    }
  } catch (err) {
    console.error('Помилка bounties:', err);
    await ctx.reply('Не вдалося завантажити список завдань.');
  }
});

bot.action(/take_(.+)/, async (ctx) => {
  const bountyId = ctx.match[1];
  try {
    const { data: bounty, error: bountyError } = await supabase.from('bounties').select('*').eq('id', bountyId).eq('status', 'open').single();
    if (bountyError || !bounty) return ctx.answerCbQuery('❌ Завдання вже зайняте або недоступне!');

    const { error: updateError } = await supabase.from('bounties').update({ status: 'in_progress', executor_id: ctx.from.id }).eq('id', bountyId);
    if (updateError) throw updateError;

    await ctx.editMessageText(`✅ Ви взяли в роботу баунті!\n\n🔹 *${bounty.title}*\n💰 Нагорода: **$${bounty.reward}**\n\nДля здачі надішліть: \`/submit ${bounty.id}\``, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery('Завдання успішно взято в роботу!');

    if (bounty.creator_id) {
        try { await ctx.telegram.sendMessage(bounty.creator_id, `🔔 Ваше завдання "*${bounty.title}*" взяв у роботу користувач @${ctx.from.username || ctx.from.first_name}!`); } catch (e) {}
    }
  } catch (err) {
    console.error('Помилка take:', err);
    await ctx.answerCbQuery('⚠️ Помилка.');
  }
});

bot.action(/cancel_task_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const bountyId = ctx.match[1];
    try {
        const { error } = await supabase.from('bounties').update({ status: 'open', executor_id: null }).eq('id', bountyId).eq('executor_id', ctx.from.id);
        if (error) throw error;
        await ctx.editMessageText('❌ Ви відмовилися від виконання завдання. Воно знову доступне для інших.');
    } catch (err) {
        await ctx.reply('⚠️ Не вдалося відмовитися.');
    }
});

bot.command('submit', async (ctx) => {
  const bountyId = ctx.message.text.split(' ')[1];
  if (!bountyId) return ctx.reply('⚠️ Вкажіть ID завдання. Наприклад: `/submit 1`', { parse_mode: 'Markdown' });

  try {
    const { error } = await supabase.from('bounties').update({ status: 'review' }).eq('id', bountyId).eq('executor_id', ctx.from.id);
    if (error) throw error;
    await ctx.reply('📤 Звіт успішно надіслано на перевірку адміністратору!', { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply('⚠️ Не вдалося надіслати завдання.');
  }
});

bot.action('create_task', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('createTaskWizard');
});

bot.action(/approve_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Доступ заборонено!', { show_alert: true });
    await ctx.answerCbQuery();
    const bountyId = ctx.match[1];

    try {
        const { data: bounty, error } = await supabase.from('bounties').select('*').eq('id', bountyId).single();
        if (error || !bounty) return ctx.reply('❌ Завдання не знайдено.');

        await supabase.from('bounties').update({ status: 'completed' }).eq('id', bountyId);
        await ctx.editMessageText(`🎉 Баунті *${bounty.title}* успішно підтверджено!\n💰 Виплачено: **$${bounty.reward}**`, { parse_mode: 'Markdown' });

        if (bounty.executor_id) {
            try { await ctx.telegram.sendMessage(bounty.executor_id, `🎉 Вашу роботу за завданням "*${bounty.title}*" перевірено та зараховано: **+$${bounty.reward}** 💰`, { parse_mode: 'Markdown' }); } catch (e) {}
        }
    } catch (err) {
        await ctx.reply('⚠️ Помилка підтвердження.');
    }
});

bot.action('list_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: bounties, error } = await supabase.from('bounties').select('*').eq('status', 'open');
        if (error) throw error;
        if (!bounties || bounties.length === 0) return ctx.reply('Наразі немає відкритих завдань.');

        for (const bounty of bounties) {
            await ctx.reply(`🔹 *${bounty.title}*\n💰 Нагорода: **$${bounty.reward}**\n📝 Опис: ${bounty.description}\n🆔 ID: \`${bounty.id}\``, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('🛠 Взяти в роботу', `take_${bounty.id}`)]])
            });
        }
    } catch (err) {
        await ctx.reply('Не вдалося завантажити список.');
    }
});

bot.action('my_active_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: activeTasks, error } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'in_progress');
        if (error) throw error;
        if (!activeTasks || activeTasks.length === 0) return ctx.reply('📭 У вас немає активних завдань.');

        await ctx.reply('📂 **Ваші активні завдання:**');
        for (const bounty of activeTasks) {
            await ctx.reply(`🔹 *${bounty.title}*\n💰 Нагорода: **$${bounty.reward}**\n📝 Опис: ${bounty.description}\n\n📤 Для здачі: \`/submit ${bounty.id}\``, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('❌ Відмовитися', `cancel_task_${bounty.id}`)]])
            });
        }
    } catch (err) {
        await ctx.reply('⚠️ Не вдалося завантажити активні завдання.');
    }
});

bot.action('my_completed_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: completedTasks, error } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'completed');
        if (error) throw error;
        if (!completedTasks || completedTasks.length === 0) return ctx.reply('📜 У вас поки немає завершених завдань.');

        await ctx.reply('📜 **Історія виконаних завдань:**');
        for (const bounty of completedTasks) {
            await ctx.reply(`✅ *${bounty.title}*\n💰 Отримано: **$${bounty.reward}**\n📝 Опис: ${bounty.description}`, { parse_mode: 'Markdown' });
        }
    } catch (err) {
        await ctx.reply('⚠️ Не вдалося завантажити історію.');
    }
});

bot.action('admin_reviews', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Доступ заборонено!', { show_alert: true });
    await ctx.answerCbQuery();

    try {
        const { data: reviewTasks, error } = await supabase.from('bounties').select('*').eq('status', 'review');
        if (error) throw error;
        if (!reviewTasks || reviewTasks.length === 0) return ctx.reply('📭 Немає завдань на перевірку.');

        await ctx.reply('👑 **Адмін-панель: Завдання на перевірці:**');
        for (const bounty of reviewTasks) {
            await ctx.reply(`🔍 *${bounty.title}*\n💰 Нагорода: **$${bounty.reward}**\n👤 ID виконавця: \`${bounty.executor_id}\`\n📝 Опис: ${bounty.description}`, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('✅ Підтвердити виконання', `approve_${bounty.id}`)]])
            });
        }
    } catch (err) {
        await ctx.reply('⚠️ Не вдалося завантажити список на перевірку.');
    }
});

bot.action('my_profile', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        // Безпечний пошук користувача (якщо немає в таблиці — беремо дані з Telegram)
        let { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
        
        if (!user) {
            user = { first_name: ctx.from.first_name || 'Користувач', telegram_id: ctx.from.id };
        }

        const { data: completedBounties } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'completed');

        const completedCount = completedBounties ? completedBounties.length : 0;
        const totalEarnings = completedBounties ? completedBounties.reduce((sum, b) => sum + (b.reward || 0), 0) : 0;

        await ctx.reply(`📁 **Ваш особистий кабінет**\n\n👤 Ім'я: ${user.first_name}\n🆔 Telegram ID: \`${user.telegram_id}\`\n\n📊 **Ваша статистика:**\n✅ Виконано завдань: ${completedCount}\n💰 Баланс: $${totalEarnings}`, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Помилка профілю:', err);
        // Навіть у разі неочікуваної помилки виводимо базовий профіль
        await ctx.reply(`📁 **Ваш особистий кабінет**\n\n👤 Ім'я: ${ctx.from.first_name}\n🆔 Telegram ID: \`${ctx.from.id}\`\n\n📊 **Ваша статистика:**\n✅ Виконано завдань: 0\n💰 Баланс: $0`, { parse_mode: 'Markdown' });
    }
});

bot.launch(() => console.log('🤖 Бот Pry.it успішно запущено та підключено до БД!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
}).listen(process.env.PORT || 3000);
