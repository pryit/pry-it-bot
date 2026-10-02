import http from 'http';
import { Telegraf, Markup, session, Scenes } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// 👑 Твій реальний Telegram ID для адмін-панелі
const ADMIN_ID = 103839260; 

const createTaskWizard = new Scenes.WizardScene(
    'createTaskWizard',
    async (ctx) => {
        await ctx.reply('✍️ Введіть коротку назву для нового завдання\n*(або напишіть /cancel для відміни)*', { parse_mode: 'Markdown' });
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.wizard.state.title = ctx.message.text;
        await ctx.reply('💰 Введіть суму нагороди в доларах\n*(тільки цифру, наприклад: 50 або 100)*', { parse_mode: 'Markdown' });
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
            await ctx.reply(`✅ Завдання *«${title}»* на суму **$${reward}** успішно створено!`, { parse_mode: 'Markdown' });
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
    await supabase
      .from('users')
      .upsert({ telegram_id: from.id, username: from.username || null, first_name: from.first_name || 'Користувач' }, { onConflict: 'telegram_id' });
    
    await ctx.reply(
        `👋 Привіт, **${from.first_name}**!\n\nЯ **Pry.it** — твій менеджер баунті-завдань.\nТвій профіль успішно зареєстровано в базі.\n\n👇 Обери потрібну дію в меню нижче:`, 
        {
            parse_mode: 'Markdown',
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
    if (!bounties || bounties.length === 0) return ctx.reply('📭 Наразі немає відкритих завдань.');

    for (const bounty of bounties) {
      await ctx.reply(
        `🔹 *${bounty.title}*\n\n` +
        `💰 Нагорода: **$${bounty.reward}**\n` +
        `📝 Опис: ${bounty.description}\n` +
        `🆔 ID: \`${bounty.id}\``, 
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🛠 Взяти в роботу', `take_${bounty.id}`)]])
        }
      );
    }
  } catch (err) {
    console.error('Помилка bounties:', err);
    await ctx.reply('Не вдалося завантажити список завдань.');
  }
});

// Взяти в роботу
bot.action(/take_(.+)/, async (ctx) => {
  const bountyId = ctx.match[1];
  try {
    const { data: bounty, error: bountyError } = await supabase.from('bounties').select('*').eq('id', bountyId).eq('status', 'open').single();
    if (bountyError || !bounty) return ctx.answerCbQuery('❌ Завдання вже зайняте або недоступне!');

    const { error: updateError } = await supabase.from('bounties').update({ status: 'in_progress', executor_id: ctx.from.id }).eq('id', bountyId);
    if (updateError) throw updateError;

    await ctx.editMessageText(
      `✅ **Ви взяли завдання в роботу!**\n\n` +
      `🔹 *${bounty.title}*\n` +
      `💰 Нагорода: **$${bounty.reward}**\n\n` +
      `👇 Коли виконаєте, натисніть кнопку нижче для здачі:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📤 Здати на перевірку', `submit_${bounty.id}`)],
          [Markup.button.callback('❌ Відмовитися', `cancel_task_${bounty.id}`)]
        ])
      }
    );
    await ctx.answerCbQuery('Завдання успішно взято в роботу!');

    if (bounty.creator_id) {
        try { await ctx.telegram.sendMessage(bounty.creator_id, `🔔 Ваше завдання *«${bounty.title}»* взяв у роботу користувач @${ctx.from.username || ctx.from.first_name}!`, { parse_mode: 'Markdown' }); } catch (e) {}
    }
  } catch (err) {
    console.error('Помилка take:', err);
    await ctx.answerCbQuery('⚠️ Помилка.');
  }
});

// Кнопка здачі завдання на перевірку (замість команди /submit)
bot.action(/submit_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const bountyId = ctx.match[1];

  try {
    const { data: bounty, error: bountyError } = await supabase
      .from('bounties')
      .select('*')
      .eq('id', bountyId)
      .eq('executor_id', ctx.from.id)
      .eq('status', 'in_progress')
      .single();

    if (bountyError || !bounty) {
      return ctx.reply('❌ Завдання не знайдено або ви не є його виконавцем.');
    }

    const { error: updateError } = await supabase
      .from('bounties')
      .update({ status: 'review' })
      .eq('id', bountyId);

    if (updateError) throw updateError;

    await ctx.editMessageText(
      `📤 **Звіт успішно надіслано!**\n\n` +
      `Завдання *«${bounty.title}»* передано адміністратору на перевірку. Очікуйте на результат.`,
      { parse_mode: 'Markdown' }
    );

  } catch (err) {
    console.error('Помилка здачі:', err);
    await ctx.reply('⚠️ Не вдалося надіслати завдання.');
  }
});

// Відмова від завдання
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

bot.action('create_task', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('createTaskWizard');
});

// Адмін: підтвердження виконання
bot.action(/approve_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('⛔ Доступ заборонено!', { show_alert: true });
    await ctx.answerCbQuery();
    const bountyId = ctx.match[1];

    try {
        const { data: bounty, error } = await supabase.from('bounties').select('*').eq('id', bountyId).single();
        if (error || !bounty) return ctx.reply('❌ Завдання не знайдено.');

        await supabase.from('bounties').update({ status: 'completed' }).eq('id', bountyId);
        await ctx.editMessageText(
            `🎉 **Баунті підтверджено!**\n\n` +
            `🔹 *${bounty.title}*\n` +
            `💰 Виплачено нагороду: **$${bounty.reward}**`, 
            { parse_mode: 'Markdown' }
        );

        if (bounty.executor_id) {
            try { 
                await ctx.telegram.sendMessage(
                    bounty.executor_id, 
                    `🎉 **Вашу роботу перевірено та зараховано!**\n\nЗавдання: *«${bounty.title}»*\nНагорода: **+$${bounty.reward}** 💰`, 
                    { parse_mode: 'Markdown' }
                ); 
            } catch (e) {}
        }
    } catch (err) {
        await ctx.reply('⚠️️ Помилка підтвердження.');
    }
});

bot.action('list_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: bounties, error } = await supabase.from('bounties').select('*').eq('status', 'open');
        if (error) throw error;
        if (!bounties || bounties.length === 0) return ctx.reply('📭 Наразі немає відкритих завдань.');

        for (const bounty of bounties) {
            await ctx.reply(
                `🔹 *${bounty.title}*\n\n` +
                `💰 Нагорода: **$${bounty.reward}**\n` +
                `📝 Опис: ${bounty.description}\n` +
                `🆔 ID: \`${bounty.id}\``, 
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🛠 Взяти в роботу', `take_${bounty.id}`)]])
                }
            );
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
        if (!activeTasks || activeTasks.length === 0) return ctx.reply('📭 У вас немає активних завдань у роботі.');

        await ctx.reply('📂 **Ваші активні завдання:**');
        for (const bounty of activeTasks) {
            await ctx.reply(
                `🔹 *${bounty.title}*\n\n` +
                `💰 Нагорода: **$${bounty.reward}**\n` +
                `📝 Опис: ${bounty.description}`, 
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('📤 Здати на перевірку', `submit_${bounty.id}`)],
                        [Markup.button.callback('❌ Відмовитися', `cancel_task_${bounty.id}`)]
                    ])
                }
            );
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
            await ctx.reply(
                `✅ *${bounty.title}*\n` +
                `💰 Отримано: **$${bounty.reward}**\n` +
                `📝 Опис: ${bounty.description}`, 
                { parse_mode: 'Markdown' }
            );
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
            await ctx.reply(
                `🔍 *${bounty.title}*\n\n` +
                `💰 Нагорода: **$${bounty.reward}**\n` +
                `👤 ID виконавця: \`${bounty.executor_id}\`\n` +
                `📝 Опис: ${bounty.description}`, 
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('✅ Підтвердити виконання', `approve_${bounty.id}`)]])
                }
            );
        }
    } catch (err) {
        await ctx.reply('⚠️ Не вдалося завантажити список на перевірку.');
    }
});

bot.action('my_profile', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        let { data: user } = await supabase.from('users').select('*').eq('telegram_id', ctx.from.id).single();
        if (!user) {
            user = { first_name: ctx.from.first_name || 'Користувач', telegram_id: ctx.from.id };
        }

        const { data: completedBounties } = await supabase.from('bounties').select('*').eq('executor_id', ctx.from.id).eq('status', 'completed');

        const completedCount = completedBounties ? completedBounties.length : 0;
        const totalEarnings = completedBounties ? completedBounties.reduce((sum, b) => sum + (b.reward || 0), 0) : 0;

        await ctx.reply(
            `📁 **Особистий кабінет**\n\n` +
            `👤 Ім'я: **${user.first_name}**\n` +
            `🆔 Telegram ID: \`${user.telegram_id}\`\n\n` +
            `📊 **Статистика:**\n` +
            `✅ Виконано завдань: **${completedCount}**\n` +
            `💰 Загальний баланс: **$${totalEarnings}**`, 
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        console.error('Помилка профілю:', err);
        await ctx.reply(
            `📁 **Особистий кабінет**\n\n` +
            `👤 Ім'я: **${ctx.from.first_name}**\n` +
            `🆔 Telegram ID: \`${ctx.from.id}\`\n\n` +
            `📊 **Статистика:**\n` +
            `✅ Виконано завдань: **0**\n` +
            `💰 Загальний баланс: **$0**`, 
            { parse_mode: 'Markdown' }
        );
    }
});

bot.launch(() => console.log('🤖 Бот Pry.it успішно запущено та підключено до БД!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
}).listen(process.env.PORT || 3000);
