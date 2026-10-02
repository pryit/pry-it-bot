import http from 'http';
import { Telegraf, Markup, session, Scenes } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Налаштування покрокового діалогу для створення завдання
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
                .insert([{ 
                    title, 
                    reward, 
                    description, 
                    status: 'open',
                    creator_id: ctx.from.id // Зберігаємо ID творця для сповіщень
                }]);

            if (error) throw error;

            await ctx.reply(`✅ Завдання "*${title}*" на суму $${reward} успішно створено і додано в базу!`, { parse_mode: 'Markdown' });
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

// Команда /start (головне меню з усіма опціями)
bot.start(async (ctx) => {
  const from = ctx.from;
  
  try {
    const { error } = await supabase
      .from('users')
      .upsert(
        { 
          telegram_id: from.id, 
          username: from.username || null, 
          first_name: from.first_name || 'Користувач' 
        },
        { onConflict: 'telegram_id' }
      );

    if (error) throw error;
    
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
    console.log(`Новий користувач: ${from.first_name}`);
    
  } catch (err) {
    console.error('Помилка БД:', err);
    await ctx.reply('Сталася помилка під час підключення до бази даних.');
  }
});

// Команда /bounties (перегляд доступних завдань з кнопками)
bot.command('bounties', async (ctx) => {
  try {
    const { data: bounties, error } = await supabase
      .from('bounties')
      .select('*')
      .eq('status', 'open');

    if (error) throw error;

    if (!bounties || bounties.length === 0) {
      return ctx.reply('Наразі немає відкритих завдань.');
    }

    for (const bounty of bounties) {
      const message = 
        `🔹 *${bounty.title}*\n` +
        `💰 Нагорода: **$${bounty.reward}**\n` +
        `📝 Опис: ${bounty.description}\n` +
        `🆔 ID завдання: \`${bounty.id}\``;

      await ctx.reply(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🛠 Взяти в роботу', `take_${bounty.id}`)]
        ])
      });
    }
    
  } catch (err) {
    console.error('Помилка отримання завдань:', err);
    await ctx.reply('Не вдалося завантажити список завдань.');
  }
});

// Обробка натискання кнопки "Взяти в роботу"
bot.action(/take_(.+)/, async (ctx) => {
  const bountyId = ctx.match[1];

  try {
    const { data: bounty, error: bountyError } = await supabase
      .from('bounties')
      .select('*')
      .eq('id', bountyId)
      .eq('status', 'open')
      .single();

    if (bountyError || !bounty) {
      return ctx.answerCbQuery('❌ Завдання вже зайняте або недоступне!');
    }

    const { error: updateError } = await supabase
      .from('bounties')
      .update({ status: 'in_progress', executor_id: ctx.from.id })
      .eq('id', bountyId);

    if (updateError) throw updateError;

    await ctx.editMessageText(
      `✅ Ви успішно взяли в роботу баунті!\n\n` +
      `🔹 *${bounty.title}*\n` +
      `💰 Нагорода: **$${bounty.reward}**\n\n` +
      `Після виконання надішліть звіт через команду: \`/submit ${bounty.id}\``,
      { parse_mode: 'Markdown' }
    );

    await ctx.answerCbQuery('Завдання успішно взято в роботу!');

    // Надсилаємо сповіщення творцю завдання (якщо вказаний creator_id)
    if (bounty.creator_id) {
        try {
            await ctx.telegram.sendMessage(
                bounty.creator_id, 
                `🔔 Ваше завдання "*${bounty.title}*" щойно взяв у роботу користувач @${ctx.from.username || ctx.from.first_name}!`
            );
        } catch (notifErr) {
            console.log('Не вдалося надіслати сповіщення творцю:', notifErr);
        }
    }

  } catch (err) {
    console.error('Помилка натискання кнопки take:', err);
    await ctx.answerCbQuery('⚠️ Сталася системна помилка.');
  }
});

// Команда /submit (здача завдання на перевірку)
bot.command('submit', async (ctx) => {
  const text = ctx.message.text;
  const args = text.split(' ');
  const bountyId = args[1];

  if (!bountyId) {
    return ctx.reply('⚠️ Будь ласка, вкажіть ID завдання. Наприклад: `/submit 1`', { parse_mode: 'Markdown' });
  }

  try {
    const { data: bounty, error: bountyError } = await supabase
      .from('bounties')
      .select('*')
      .eq('id', bountyId)
      .eq('executor_id', ctx.from.id)
      .eq('status', 'in_progress')
      .single();

    if (bountyError || !bounty) {
      return ctx.reply('❌ Завдання з таким ID не знайдено або ви не є його виконавцем.');
    }

    const { error: updateError } = await supabase
      .from('bounties')
      .update({ status: 'review' })
      .eq('id', bountyId);

    if (updateError) throw updateError;

    await ctx.reply(
      `📤 Ви успішно надіслали звіт по баунті *${bounty.title}* на перевірку!\n\n` +
      `Адміністратор перевірить вашу роботу найближчим часом.`,
      { parse_mode: 'Markdown' }
    );

  } catch (err) {
    console.error('Помилка здачі завдання:', err);
    await ctx.reply('⚠️ Не вдалося надіслати завдання через системну помилку.');
  }
});

bot.action('create_task', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('createTaskWizard');
});

// Обробка підтвердження виконання через адмін-панель (кнопка)
bot.action(/approve_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const bountyId = ctx.match[1];

    try {
        const { data: bounty, error: bountyError } = await supabase
            .from('bounties')
            .select('*')
            .eq('id', bountyId)
            .eq('status', 'review')
            .single();

        if (bountyError || !bounty) {
            return ctx.reply('❌ Завдання не знайдено або воно вже перевірено.');
        }

        const { error: updateError } = await supabase
            .from('bounties')
            .update({ status: 'completed' })
            .eq('id', bountyId);

        if (updateError) throw updateError;

        await ctx.editMessageText(
            `🎉 Баунті *${bounty.title}* успішно підтверджено та завершено!\n💰 Виплачено нагороду: **$${bounty.reward}**`,
            { parse_mode: 'Markdown' }
        );

        // Повідомляємо виконавця про успішне зарахування
        if (bounty.executor_id) {
            try {
                await ctx.telegram.sendMessage(
                    bounty.executor_id,
                    `🎉 Вітаємо! Вашу роботу за завданням "*${bounty.title}*" перевірено та зараховано на баланс: **+$${bounty.reward}** 💰`,
                    { parse_mode: 'Markdown' }
                );
            } catch (execErr) {
                console.log('Не вдалося сповістити виконавця:', execErr);
            }
        }

    } catch (err) {
        console.error('Помилка approve action:', err);
        await ctx.reply('⚠️ Системна помилка під час підтвердження.');
    }
});

// Команда /approve (для ручного введення)
bot.command('approve', async (ctx) => {
  const text = ctx.message.text;
  const args = text.split(' ');
  const bountyId = args[1];

  if (!bountyId) {
    return ctx.reply('⚠️ Вкажіть ID завдання. Наприклад: `/approve 2`', { parse_mode: 'Markdown' });
  }

  try {
    const { data: bounty, error: bountyError } = await supabase
      .from('bounties')
      .select('*')
      .eq('id', bountyId)
      .eq('status', 'review')
      .single();

    if (bountyError || !bounty) {
      return ctx.reply('❌ Завдання не знайдено або воно не на перевірці.');
    }

    const { error: updateError } = await supabase
      .from('bounties')
      .update({ status: 'completed' })
      .eq('id', bountyId);

    if (updateError) throw updateError;

    await ctx.reply(
      `🎉 Баунті *${bounty.title}* успішно підтверджено та завершено!\n\n` +
      `💰 Нагорода **$${bounty.reward}** готова до виплати.`,
      { parse_mode: 'Markdown' }
    );

    if (bounty.executor_id) {
        try {
            await ctx.telegram.sendMessage(
                bounty.executor_id,
                `🎉 Вашу роботу за завданням "*${bounty.title}*" підтверджено! Нагорода: **+$${bounty.reward}**`,
                { parse_mode: 'Markdown' }
            );
        } catch (e) {}
    }

  } catch (err) {
    console.error('Помилка approve:', err);
    await ctx.reply('⚠️️ Системна помилка.');
  }
});

// Обробник кнопки "Список доступних завдань"
bot.action('list_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: bounties, error } = await supabase
            .from('bounties')
            .select('*')
            .eq('status', 'open');

        if (error) throw error;

        if (!bounties || bounties.length === 0) {
            return ctx.reply('Наразі немає відкритих завдань. Створіть перше!');
        }

        for (const bounty of bounties) {
            const message = 
                `🔹 *${bounty.title}*\n` +
                `💰 Нагорода: **$${bounty.reward}**\n` +
                `📝 Опис: ${bounty.description}\n` +
                `🆔 ID: \`${bounty.id}\``;

            await ctx.reply(message, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🛠 Взяти в роботу', `take_${bounty.id}`)]
                ])
            });
        }
    } catch (err) {
        console.error('Помилка отримання завдань:', err);
        await ctx.reply('Не вдалося завантажити список завдань.');
    }
});

// Обробник кнопки "Мої завдання в роботі"
bot.action('my_active_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: activeTasks, error } = await supabase
            .from('bounties')
            .select('*')
            .eq('executor_id', ctx.from.id)
            .eq('status', 'in_progress');

        if (error) throw error;

        if (!activeTasks || activeTasks.length === 0) {
            return ctx.reply('📭 У вас немає завдань, які зараз перебувають у роботі.');
        }

        await ctx.reply('📂 **Ваші активні завдання:**');

        for (const bounty of activeTasks) {
            const message = 
                `🔹 *${bounty.title}*\n` +
                `💰 Нагорода: **$${bounty.reward}**\n` +
                `📝 Опис: ${bounty.description}\n\n` +
                `📤 Для здачі надішліть: \`/submit ${bounty.id}\``;

            await ctx.reply(message, { parse_mode: 'Markdown' });
        }
    } catch (err) {
        console.error('Помилка отримання активних завдань:', err);
        await ctx.reply('⚠️ Не вдалося завантажити ваші активні завдання.');
    }
});

// Обробник кнопки "Історія виконаних завдань"
bot.action('my_completed_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: completedTasks, error } = await supabase
            .from('bounties')
            .select('*')
            .eq('executor_id', ctx.from.id)
            .eq('status', 'completed');

        if (error) throw error;

        if (!completedTasks || completedTasks.length === 0) {
            return ctx.reply('📜 У вас поки немає завершених та оплачених завдань.');
        }

        await ctx.reply('📜 **Історія ваших виконаних завдань:**');

        for (const bounty of completedTasks) {
            const message = 
                `✅ *${bounty.title}*\n` +
                `💰 Отримано: **$${bounty.reward}**\n` +
                `📝 Опис: ${bounty.description}`;

            await ctx.reply(message, { parse_mode: 'Markdown' });
        }
    } catch (err) {
        console.error('Помилка отримання історії:', err);
        await ctx.reply('⚠️ Не вдалося завантажити історію завдань.');
    }
});

// Адмін-панель: перегляд завдань на перевірці (review) з кнопкою підтвердження
bot.action('admin_reviews', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: reviewTasks, error } = await supabase
            .from('bounties')
            .select('*')
            .eq('status', 'review');

        if (error) throw error;

        if (!reviewTasks || reviewTasks.length === 0) {
            return ctx.reply('📭 Немає завдань, які очікують на перевірку.');
        }

        await ctx.reply('👑 **Адмін-панель: Завдання на перевірці:**');

        for (const bounty of reviewTasks) {
            const message = 
                `🔍 *${bounty.title}*\n` +
                `💰 Нагорода: **$${bounty.reward}**\n` +
                `👤 ID виконавця: \`${bounty.executor_id}\`\n` +
                `📝 Опис: ${bounty.description}`;

            await ctx.reply(message, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Підтвердити виконання', `approve_${bounty.id}`)]
                ])
            });
        }
    } catch (err) {
        console.error('Помилка адмін-панелі:', err);
        await ctx.reply('⚠️ Не вдалося завантажити список на перевірку.');
    }
});

// Обробник кнопки "Мій профіль"
bot.action('my_profile', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', ctx.from.id)
            .single();

        if (userError) throw userError;

        const { data: completedBounties, error: bountiesError } = await supabase
            .from('bounties')
            .select('*')
            .eq('executor_id', ctx.from.id)
            .eq('status', 'completed');

        if (bountiesError) throw bountiesError;

        const completedCount = completedBounties ? completedBounties.length : 0;
        const totalEarnings = completedBounties ? completedBounties.reduce((sum, b) => sum + (b.reward || 0), 0) : 0;

        const profileMessage = 
            `📁 **Ваш особистий кабінет**\n\n` +
            `👤 Ім'я: ${user.first_name}\n` +
            `🆔 Telegram ID: \`${user.telegram_id}\`\n\n` +
            `📊 **Ваша статистика:**\n` +
            `✅ Виконано завдань: ${completedCount}\n` +
            `💰 Баланс: $${totalEarnings}`;

        await ctx.reply(profileMessage, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Помилка завантаження профілю:', err);
        await ctx.reply('⚠️️ Не вдалося завантажити дані профілю з бази.');
    }
});

bot.launch(() => console.log('🤖 Бот Pry.it успішно запущено та підключено до БД!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
}).listen(process.env.PORT || 3000);
