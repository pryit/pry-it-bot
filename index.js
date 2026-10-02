import http from 'http';
import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Команда /start
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
                    [{ text: '➕ Створити нове завдання', callback_data: 'create_task' }],
                    [{ text: '💼 Мій профіль', callback_data: 'my_profile' }]
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

      // Додаємо інтерактивну кнопку під кожним завданням
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
      .update({ status: 'in_progress' })
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
      .eq('status', 'in_progress')
      .single();

    if (bountyError || !bounty) {
      return ctx.reply('❌ Завдання з таким ID не знайдено або воно не перебуває в роботі.');
    }

    const { error: updateError } = await supabase
      .from('bounties')
      .update({ status: 'review' })
      .eq('id', bountyId);

    if (updateError) throw updateError;

    await ctx.reply(
      `📤 Ви успішно надіслали звіт по баунті *${bounty.title}* на перевірку!\n\n` +
      `Адміністратор перевірить вашу роботу найближчим часом. (Для затвердження адмін може використати \`/approve ${bounty.id}\`)`,
      { parse_mode: 'Markdown' }
    );

  } catch (err) {
    console.error('Помилка здачі завдання:', err);
    await ctx.reply('⚠️ Не вдалося надіслати завдання через системну помилку.');
  }
});

// Команда /create (створення нового баунті)
bot.command('create', async (ctx) => {
  const text = ctx.message.text.replace('/create', '').trim();
  const parts = text.split('|').map(p => p.trim());

  if (parts.length < 3) {
    return ctx.reply(
      '⚠️ Неправильний формат!\n\n' +
      'Використовуйте так:\n' +
      '`/create Назва завдання | Сумма | Опис завдання`',
      { parse_mode: 'Markdown' }
    );
  }

  const [title, rewardStr, description] = parts;
  const reward = parseFloat(rewardStr);

  if (isNaN(reward)) {
    return ctx.reply('❌ Помилка: нагорода має бути числом.', { parse_mode: 'Markdown' });
  }

  try {
    const { error } = await supabase
      .from('bounties')
      .insert([{ title, reward, description, status: 'open' }]);

    if (error) throw error;

    await ctx.reply(
      `✅ Нове баунті-завдання успішно створено та опубліковано!\n\n` +
      `🔹 *${title}*\n` +
      `💰 Нагорода: **$${reward}**\n` +
      `📝 Опис: ${description}`,
      { parse_mode: 'Markdown' }
    );

  } catch (err) {
    console.error('Помилка створення завдання:', err);
    await ctx.reply('⚠️ Не вдалося створити завдання.');
  }
});

// Команда /approve (підтвердження адміністратором)
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

  } catch (err) {
    console.error('Помилка approve:', err);
    await ctx.reply('⚠️ Системна помилка.');
  }
});
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
bot.action('my_profile', async (ctx) => {
    await ctx.answerCbQuery();
    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', ctx.from.id)
            .single();

        if (error) throw error;

        const profileMessage = 
            `💼 **Ваш особистий кабінет**\n\n` +
            `👤 Ім'я: ${user.first_name}\n` +
            `🆔 Telegram ID: \`${user.telegram_id}\`\n\n` +
            `📊 **Ваша статистика (незабаром):**\n` +
            `✅ Виконано завдань: 0\n` +
            `💰 Баланс: $0`;

        await ctx.reply(profileMessage, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Помилка завантаження профілю:', err);
        await ctx.reply('⚠️ Не вдалося завантажити дані профілю з бази.');
    }
});


bot.action('my_profile', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`💼 Ваш профіль: ${ctx.from.first_name}\nТут буде відображатися ваша статистика, статус та зароблені кошти.`);
});
bot.launch(() => console.log('🤖 Бот Pry.it успішно запущено та підключено до БД!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
}).listen(process.env.PORT || 3000);
