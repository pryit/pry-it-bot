import http from 'node:http';
import { Telegraf, Markup, session } from 'telegraf';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('У файлі .env не вказано TELEGRAM_BOT_TOKEN.');

const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID || '1038839260');
if (!Number.isSafeInteger(ADMIN_ID) || ADMIN_ID <= 0) {
  throw new Error('ADMIN_TELEGRAM_ID має бути числовим Telegram ID.');
}

const bot = new Telegraf(BOT_TOKEN);
const CATEGORIES = [
  'Дизайн',
  'Фото та відео',
  'Розробка та автоматизація',
  'Маркетинг',
  'Інше'
];
const CURRENCIES = ['UAH', 'EUR', 'USD'];
const MAX_ITEMS = 8;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function messageText(ctx) {
  return String(ctx.message?.text || '').trim();
}

function parseMoney(value) {
  const normalized = String(value || '').replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : null;
}

function parseDeadline(value) {
  const input = String(value || '').trim();
  const local = input.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const iso = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let day;
  let month;
  let year;

  if (local) {
    day = Number(local[1]);
    month = Number(local[2]);
    year = Number(local[3]);
  } else if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    return null;
  }

  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) return null;

  // Convert the end of the selected Kyiv calendar day to UTC. Noon is used to
  // read the correct UTC offset for that date, including daylight saving time.
  const utcNoon = Date.UTC(year, month - 1, day, 12);
  const kyivParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(utcNoon));
  const localParts = Object.fromEntries(kyivParts.map((part) => [part.type, part.value]));
  const kyivAsUtc = Date.UTC(
    Number(localParts.year), Number(localParts.month) - 1, Number(localParts.day),
    Number(localParts.hour), Number(localParts.minute), Number(localParts.second)
  );
  const kyivOffset = kyivAsUtc - utcNoon;
  const deadline = new Date(Date.UTC(year, month - 1, day, 23, 59, 59) - kyivOffset);
  return deadline.getTime() > Date.now() ? deadline.toISOString() : null;
}

function money(amount, currency = 'UAH') {
  const code = CURRENCIES.includes(currency) ? currency : 'UAH';
  return new Intl.NumberFormat('uk-UA', {
    style: 'currency',
    currency: code,
    maximumFractionDigits: 2
  }).format(Number(amount || 0));
}

function dateText(value) {
  if (!value) return 'не вказано';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'не вказано';
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'medium',
    timeZone: 'Europe/Kyiv'
  }).format(date);
}

function statusText(status) {
  return ({
    pending_approval: 'На перевірці',
    open: 'Шукає виконавця',
    in_progress: 'У роботі',
    review: 'Очікує перевірки результату',
    completed: 'Завершено',
    cancelled: 'Скасовано'
  })[status] || 'Статус оновлюється';
}

function userName(user) {
  if (!user) return 'Користувач Pry.it';
  return user.username ? '@' + user.username : (user.first_name || 'Користувач Pry.it');
}

function telegramContact(user) {
  if (!user?.telegram_id) return 'контакт недоступний';
  return '<a href="tg://user?id=' + Number(user.telegram_id) + '">' +
    escapeHtml(userName(user)) + '</a>';
}

function isAdmin(ctx) {
  return Number(ctx.from?.id) === ADMIN_ID;
}

async function answerCallback(ctx, text = '') {
  try {
    await ctx.answerCbQuery(text);
  } catch {
    // Callback buttons can expire while the user is away.
  }
}

async function getUser(ctx) {
  if (!ctx.from) throw new Error('Telegram user is missing.');

  const { data, error } = await supabase
    .from('users')
    .upsert({
      telegram_id: ctx.from.id,
      username: ctx.from.username || null,
      first_name: ctx.from.first_name || 'Користувач'
    }, { onConflict: 'telegram_id' })
    .select('id, telegram_id, username, first_name, role')
    .single();

  if (error) throw error;
  return data;
}

async function userById(id) {
  const { data, error } = await supabase
    .from('users')
    .select('id, telegram_id, username, first_name')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function notify(userId, text, replyMarkup) {
  try {
    await bot.telegram.sendMessage(userId, text, {
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})

    });
  } catch (error) {
    console.warn('Не удалось отправить уведомление:', error.message);
  }
}

function menu(userId) {
  const rows = [
    [
      Markup.button.callback('🔎 Знайти проєкт', 'list_tasks'),
      Markup.button.callback('➕ Опублікувати проєкт', 'create_task')
    ],
    [
      Markup.button.callback('📨 Мої пропозиції', 'my_proposals'),
      Markup.button.callback('🧾 Мої проєкти', 'my_projects')
    ],
    [
      Markup.button.callback('🛠 Моя робота', 'my_work'),
      Markup.button.callback('👤 Профіль', 'my_profile')
    ]
  ];
  if (Number(userId) === ADMIN_ID) {
    rows.push([Markup.button.callback('⚙️ Адміністратор', 'admin_main')]);
  }
  return Markup.inlineKeyboard(rows);
}

function backMenu(callback = 'main_menu') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔙 В меню', callback)]
  ]);
}

async function showPage(ctx, text, keyboard) {
  const options = { parse_mode: 'HTML', ...keyboard };
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch {
      // A new message is used if the old one cannot be edited.
    }
  }
  await ctx.reply(text, options);
}

function welcomeText() {
  return '<b>Pry.it — цифрові проєкти для українського бізнесу</b>\n\n' +
    'Дизайн, відео, маркетинг і автоматизація: замовник публікує завдання, фрилансери надсилають пропозиції, а замовник обирає виконавця.\n\n' +
    'Не знаєте, як сформулювати запит? Опишіть проблему й бажаний результат звичайними словами — технічні терміни не потрібні.\n\n' +
    '⚠️ Бот поки не приймає платежі й не зберігає гроші. Сторони окремо погоджують оплату та умови.';
}

async function showHome(ctx, edit = false) {
  if (edit && ctx.callbackQuery) {
    await showPage(ctx, welcomeText(), menu(ctx.from.id));
    return;
  }
  await ctx.reply(welcomeText(), {
    parse_mode: 'HTML',
    ...menu(ctx.from.id)
  });
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && value.length <= 1500;
  } catch {
    return false;
  }
}

async function reportError(ctx, label, error) {
  console.error(label, error);
  const text = 'Не вдалося виконати дію. Спробуйте ще раз трохи пізніше.';
  if (ctx.callbackQuery) {
    await answerCallback(ctx, 'Сталася помилка.');
    try {
      await ctx.reply(text, menu(ctx.from?.id || 0));
    } catch {
      // The chat may have been closed.
    }
    return;
  }
  try {
    await ctx.reply(text, menu(ctx.from?.id || 0));
  } catch {
    // The chat may have been closed.
  }
}

bot.catch((error, ctx) => {
  console.error('Помилка бота:', error);
  if (ctx.from) {
    ctx.reply('Сталася помилка. Напишіть /start, щоб повернутися до меню.')
      .catch(() => {});
  }
});

bot.use(session({ defaultSession: () => ({ form: null }) }));

bot.start(async (ctx) => {
  ctx.session.form = null;
  try {
    await getUser(ctx);
    await ctx.reply(welcomeText(), {
      parse_mode: 'HTML',
      ...menu(ctx.from.id)
    });
  } catch (error) {
    await reportError(ctx, 'Помилка реєстрації користувача:', error);
  }
});

bot.command('menu', async (ctx) => {
  ctx.session.form = null;
  await showHome(ctx);
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    'Як працює Pry.it:\n' +
    '1. Замовник публікує проєкт.\n' +
    '2. Фрилансери надсилають пропозиції.\n' +
    '3. Замовник обирає виконавця.\n' +
    '4. Виконавець передає результат, замовник підтверджує завершення.\n\n' +
    'Команда /cancel скасовує заповнення. Платежі поки проходять поза ботом.',
    backMenu()
  );
});

bot.command('cancel', async (ctx) => {
  ctx.session.form = null;
  await ctx.reply('Заповнення скасовано.', menu(ctx.from.id));
});

bot.action('main_menu', async (ctx) => {
  await answerCallback(ctx);
  ctx.session.form = null;
  await showHome(ctx, true);
});

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Ця команда доступна лише адміністратору.');
  await ctx.reply('⚙️ <b>Панель адміністратора</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📝 Проєкти на перевірці', 'admin_pending')],
      [Markup.button.callback('🔙 Головне меню', 'main_menu')]
    ])
  });
});

// Project creation: moderation first, then the project appears in the public feed.

bot.action('create_task', async (ctx) => {
  await answerCallback(ctx);
  try {
    await getUser(ctx);
    ctx.session.form = { type: 'create', step: 'problem' };
    await ctx.reply(
      'Створення проєкту — крок 1 із 7.\n\n' +
      'Опишіть звичайними словами, що зараз не влаштовує у вашому бізнесі або що хочете покращити. Не потрібно знати технічних термінів.\n\n' +
      'Наприклад: «Заявки з Instagram губляться, хочу збирати їх в одному місці». Не надсилайте паролі чи дані клієнтів.\n\n' +
      'Команда /cancel скасує заповнення.'
    );
  } catch (error) {
    await reportError(ctx, 'Помилка запуску створення проєкту:', error);
  }
});

async function saveProject(ctx, form) {
  const user = await getUser(ctx);
  const deadline = parseDeadline(form.deadline);
  if (!deadline) {
    form.step = 'deadline';
    return ctx.reply('Дата минула або вказана неправильно. Введіть майбутню дату у форматі ДД.ММ.РРРР.');
  }

  const { data: project, error } = await supabase
    .from('bounties')
    .insert({
      client_id: user.id,
      title: form.title,
      category: form.category,
      description: form.description,
      budget: form.budget,
      reward: form.budget,
      currency: form.currency,
      deadline,
      status: 'pending_approval'
    })
    .select('id, title, category, budget, currency, deadline')
    .single();

  if (error) throw error;

  ctx.session.form = null;
  await ctx.reply(
    '✅ Проєкт передано на перевірку.\n\n' +
    '<b>' + escapeHtml(project.title) + '</b>\n' +
    escapeHtml(project.category) + ' · ' +
    escapeHtml(money(project.budget, project.currency)) + '\n' +
    'Термін: ' + escapeHtml(dateText(project.deadline)) + '\n\n' +
    'Після перевірки проєкт з’явиться в каталозі. Оплату сторони погоджують напряму, поза ботом.',
    { parse_mode: 'HTML', ...menu(ctx.from.id) }
  );

  const adminMessage =
    '🆕 <b>Новий проєкт на перевірці</b>\n\n' +
    '<b>' + escapeHtml(project.title) + '</b>\n' +
    escapeHtml(project.category) + ' · ' +
    escapeHtml(money(project.budget, project.currency)) + '\n' +
    'Термін: ' + escapeHtml(dateText(project.deadline)) + '\n\n' +
    escapeHtml(form.description.slice(0, 1200));

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Опублікувати', 'admin_publish_' + project.id)],
    [Markup.button.callback('❌ Відхилити', 'admin_reject_' + project.id)]
  ]).reply_markup;
  await notify(ADMIN_ID, adminMessage, keyboard);
}

bot.action(/^list_tasks(?:_(\d+))?$/, async (ctx) => {
  await answerCallback(ctx);
  try {
    const page = Math.max(0, Number(ctx.match[1] || 0));
    const { data: projects, error } = await supabase
      .from('bounties')
      .select('id, title, category, description, budget, currency, deadline', { count: 'exact' })
      .eq('status', 'open')
      .gt('deadline', new Date().toISOString())
      .order('created_at', { ascending: false })
      .range(page * MAX_ITEMS, page * MAX_ITEMS + MAX_ITEMS - 1);

    if (error) throw error;
    if (!projects?.length) {
      return showPage(
        ctx,
        '🔎 <b>Поки немає відкритих проєктів.</b>\n\nЗавітайте пізніше або розкажіть про Pry.it замовникам.',
        menu(ctx.from.id)
      );
    }

    const cards = projects.map((project, index) => {
      const description = String(project.description || '').slice(0, 120);
      const suffix = project.description?.length > 120 ? '…' : '';
      return (index + 1) + '. <b>' + escapeHtml(project.title) + '</b>\n' +
        escapeHtml(project.category || 'Інше') + ' · ' +
        escapeHtml(money(project.budget, project.currency)) + '\n' +
        'До ' + escapeHtml(dateText(project.deadline)) + '\n' +
        escapeHtml(description + suffix);
    }).join('\n\n');

    const rows = projects.map((project) => [
      Markup.button.callback('Відкрити: ' + String(project.title).slice(0, 28), 'task_' + project.id)
    ]);
    const pageButtons = [];
    if (page > 0) pageButtons.push(Markup.button.callback('⬅️ Назад', 'list_tasks_' + (page - 1)));
    if ((page + 1) * MAX_ITEMS < Number(count || 0)) {
      pageButtons.push(Markup.button.callback('Далі ➡️', 'list_tasks_' + (page + 1)));
    }
    if (pageButtons.length) rows.push(pageButtons);
    rows.push([Markup.button.callback('🔙 У меню', 'main_menu')]);

    await showPage(ctx, '<b>Відкриті проєкти</b>\n\n' + cards, Markup.inlineKeyboard(rows));
  } catch (error) {
    await reportError(ctx, 'Помилка завантаження проєктів:', error);
  }
});

bot.action(/^task_(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  try {
    const user = await getUser(ctx);
    const { data: project, error } = await supabase
      .from('bounties')
      .select('*')
      .eq('id', ctx.match[1])
      .maybeSingle();

    if (error) throw error;
    if (!project) return ctx.reply('Цей проєкт уже недоступний.', menu(ctx.from.id));

    const text =
      '<b>' + escapeHtml(project.title) + '</b>\n' +
      escapeHtml(project.category || 'Інше') + '\n\n' +
      escapeHtml(project.description) + '\n\n' +

      'Бюджет: <b>' + escapeHtml(money(project.budget, project.currency)) + '</b>\n' +
      'Термін: <b>' + escapeHtml(dateText(project.deadline)) + '</b>\n' +
      'Статус: ' + escapeHtml(statusText(project.status));

    const rows = [];
    if (project.client_id === user.id && project.status === 'open') {
      rows.push([Markup.button.callback('📨 Переглянути пропозиції', 'responses_' + project.id)]);
    } else if (
      project.status === 'open' &&
      project.client_id !== user.id &&
      new Date(project.deadline).getTime() > Date.now()
    ) {
      rows.push([Markup.button.callback('✍️ Надіслати пропозицію', 'apply_' + project.id)]);
    }
    rows.push([Markup.button.callback('🔎 До каталогу', 'list_tasks')]);
    rows.push([Markup.button.callback('🔙 У меню', 'main_menu')]);
    await showPage(ctx, text, Markup.inlineKeyboard(rows));
  } catch (error) {
    await reportError(ctx, 'Помилка відкриття проєкту:', error);
  }
});

bot.action(/^apply_(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  try {
    const user = await getUser(ctx);
    const { data: project, error } = await supabase
      .from('bounties')
      .select('id, title, client_id, status, deadline, currency, budget')
      .eq('id', ctx.match[1])
      .maybeSingle();

    if (error) throw error;
    if (!project || project.status !== 'open' || new Date(project.deadline).getTime() <= Date.now()) {
      return ctx.reply('Прийом пропозицій за цим проєктом завершено.');
    }
    if (project.client_id === user.id) return ctx.reply('Не можна надіслати пропозицію до власного проєкту.');

    ctx.session.form = {
      type: 'proposal',
      step: 'price',
      projectId: project.id,
      currency: project.currency,
      budget: Number(project.budget)
    };
    await ctx.reply(
      'Пропозиція до проєкту «' + project.title + '».\n\n' +
      'Укажіть свою ціну в ' + project.currency + ' або надішліть /skip, якщо підходить бюджет ' +
      money(project.budget, project.currency) + '.'
    );
  } catch (error) {
    await reportError(ctx, 'Помилка початку відгуку:', error);
  }
});

async function saveProposal(ctx, form) {
  const user = await getUser(ctx);
  const { data: project, error: projectError } = await supabase
    .from('bounties')
    .select('id, title, client_id, status, deadline')
    .eq('id', form.projectId)
    .maybeSingle();

  if (projectError) throw projectError;
  if (!project || project.status !== 'open' || new Date(project.deadline).getTime() <= Date.now()) {
    ctx.session.form = null;
    return ctx.reply('Прийом пропозицій за цим проєктом уже завершено.', menu(ctx.from.id));
  }
  if (project.client_id === user.id) {
    ctx.session.form = null;
    return ctx.reply('Не можна надіслати пропозицію до власного проєкту.', menu(ctx.from.id));
  }

  const { data: existing, error: existingError } = await supabase
    .from('submissions')
    .select('id')
    .eq('bounty_id', project.id)
    .eq('freelancer_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) throw existingError;

  const fields = {
    proposal_text: form.message,
    work_url: form.portfolioUrl || null,
    proposed_budget: form.proposedBudget,
    delivery_url: null,
    revision_note: null,
    is_winner: false
  };

  let saveError;
  if (existing) {
    const result = await supabase.from('submissions').update(fields).eq('id', existing.id);
    saveError = result.error;
  } else {
    const result = await supabase
      .from('submissions')
      .insert({ ...fields, bounty_id: project.id, freelancer_id: user.id });
    saveError = result.error;
  }
  if (saveError) throw saveError;

  ctx.session.form = null;
  await ctx.reply('✅ Пропозицію надіслано замовнику. Якщо вас оберуть, бот повідомить.', menu(ctx.from.id));

  const client = await userById(project.client_id);
  if (client) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📨 Переглянути пропозиції', 'responses_' + project.id)]
    ]).reply_markup;
    await notify(client.telegram_id, '📨 На проєкт «' + escapeHtml(project.title) + '» надійшла пропозиція.', keyboard);
  }
}

bot.action('my_proposals', async (ctx) => {
  await answerCallback(ctx);
  try {

    const user = await getUser(ctx);
    const { data: proposals, error } = await supabase
      .from('submissions')
      .select('id, bounty_id, proposed_budget, is_winner, created_at')
      .eq('freelancer_id', user.id)
      .order('created_at', { ascending: false })
      .limit(MAX_ITEMS);

    if (error) throw error;
    if (!proposals?.length) {
      return showPage(ctx, '📨 <b>Ви ще не надсилали пропозицій.</b>', menu(ctx.from.id));
    }

    const projectIds = [...new Set(proposals.map((item) => item.bounty_id))];
    const { data: projects, error: projectsError } = await supabase
      .from('bounties')
      .select('id, title, budget, currency, status')
      .in('id', projectIds);

    if (projectsError) throw projectsError;
    const byId = new Map((projects || []).map((item) => [item.id, item]));
    const lines = proposals.map((proposal) => {
      const project = byId.get(proposal.bounty_id);
      if (!project) return 'Проєкт видалено';
      const price = proposal.proposed_budget || project.budget;
      return '<b>' + escapeHtml(project.title) + '</b>\n' +
        escapeHtml(statusText(project.status)) + ' · ' +
        escapeHtml(money(price, project.currency)) +
        (proposal.is_winner ? '\n✅ Вас обрали виконавцем' : '');
    });

    await showPage(ctx, '<b>Мої пропозиції</b>\n\n' + lines.join('\n\n'), menu(ctx.from.id));
  } catch (error) {
    await reportError(ctx, 'Помилка завантаження пропозицій:', error);
  }
});

bot.action('my_projects', async (ctx) => {
  await answerCallback(ctx);
  try {
    const user = await getUser(ctx);
    const { data: projects, error } = await supabase
      .from('bounties')
      .select('id, title, category, budget, currency, deadline, status')
      .eq('client_id', user.id)
      .order('created_at', { ascending: false })
      .limit(MAX_ITEMS);

    if (error) throw error;
    if (!projects?.length) {
      return showPage(ctx, '🧾 <b>Ви ще не публікували проєктів.</b>', menu(ctx.from.id));
    }

    const rows = [];
    for (const project of projects) {
      rows.push([Markup.button.callback(
        String(project.title).slice(0, 28) + ' · ' + statusText(project.status),
        'task_' + project.id
      )]);
      if (project.status === 'open') {
        rows.push([Markup.button.callback('📨 Пропозиції: ' + String(project.title).slice(0, 20), 'responses_' + project.id)]);
      }
      if (project.status === 'review') {
        rows.push([Markup.button.callback('📦 Перевірити результат', 'review_delivery_' + project.id)]);
      }
      if (project.status === 'completed' && project.winner_id) {
        rows.push([Markup.button.callback('⭐ Залишити відгук', 'review_' + project.id)]);
      }
    }
    rows.push([Markup.button.callback('🔙 У меню', 'main_menu')]);

    const cards = projects.map((project) =>
      '<b>' + escapeHtml(project.title) + '</b>\n' +
      escapeHtml(project.category || 'Інше') + ' · ' +
      escapeHtml(money(project.budget, project.currency)) + '\n' +
      escapeHtml(statusText(project.status))
    ).join('\n\n');
    await showPage(ctx, '<b>Мої проєкти</b>\n\n' + cards, Markup.inlineKeyboard(rows));
  } catch (error) {
    await reportError(ctx, 'Помилка завантаження проєктів:', error);
  }
});

bot.action(/^responses_(\d+)(?:_(\d+))?$/, async (ctx) => {
  await answerCallback(ctx);
  try {
    const user = await getUser(ctx);
    const { data: project, error: projectError } = await supabase
      .from('bounties')
      .select('id, title, client_id, status, budget, currency')
      .eq('id', ctx.match[1])
      .maybeSingle();

    if (projectError) throw projectError;
    if (!project || project.client_id !== user.id) {
      return ctx.reply('Пропозиції може переглядати лише замовник цього проєкту.');
    }

    const page = Math.max(0, Number(ctx.match[2] || 0));
    const pageSize = 4;
    const { data: proposals, error, count } = await supabase
      .from('submissions')
      .select('id, freelancer_id, proposal_text, work_url, proposed_budget, is_winner, created_at', { count: 'exact' })
      .eq('bounty_id', project.id)
      .order('created_at', { ascending: false })
      .range(page * pageSize, page * pageSize + pageSize - 1);

    if (error) throw error;
    if (!proposals?.length) {
      return showPage(ctx, '📭 На проєкт «' + escapeHtml(project.title) + '» поки не надійшло пропозицій.', backMenu('my_projects'));
    }

    const freelancerIds = [...new Set(proposals.map((proposal) => proposal.freelancer_id))];

    const { data: freelancers, error: freelancersError } = await supabase
      .from('users')
      .select('id, telegram_id, username, first_name')
      .in('id', freelancerIds);

    if (freelancersError) throw freelancersError;
    const people = new Map((freelancers || []).map((person) => [person.id, person]));
    const rows = [];
    const cards = proposals.map((proposal, index) => {
      const freelancer = people.get(proposal.freelancer_id);
      const name = userName(freelancer);
      const proposalText = String(proposal.proposal_text || '');
      const preview = proposalText.slice(0, 360) + (proposalText.length > 360 ? '…' : '');
      let card = (page * pageSize + index + 1) + '. <b>' + escapeHtml(name) + '</b>\n' +
        escapeHtml(preview) + '\n' +
        'Ціна: ' + escapeHtml(money(proposal.proposed_budget || project.budget, project.currency));
      if (proposal.work_url) {
        card += '\nПортфоліо: <a href="' + escapeHtml(proposal.work_url) + '">відкрити посилання</a>';
      }
      if (proposal.is_winner) card += '\n✅ Виконавця обрано';
      if (project.status === 'open' && !proposal.is_winner) {
        rows.push([Markup.button.callback('Обрати ' + String(name).slice(0, 22), 'choose_' + proposal.id)]);
      }
      return card;
    });

    const pageButtons = [];
    if (page > 0) pageButtons.push(Markup.button.callback('⬅️ Назад', 'responses_' + project.id + '_' + (page - 1)));
    if ((page + 1) * pageSize < Number(count || 0)) {
      pageButtons.push(Markup.button.callback('Далі ➡️', 'responses_' + project.id + '_' + (page + 1)));
    }
    if (pageButtons.length) rows.push(pageButtons);
    rows.push([Markup.button.callback('🔙 До моїх проєктів', 'my_projects')]);
    await showPage(
      ctx,
      '<b>Пропозиції до проєкту</b>\n' + escapeHtml(project.title) + '\n\n' + cards.join('\n\n'),
      Markup.inlineKeyboard(rows)
    );
  } catch (error) {
    await reportError(ctx, 'Помилка завантаження пропозицій:', error);
  }
});

bot.action(/^choose_([0-9a-f-]{36})$/i, async (ctx) => {
  await answerCallback(ctx);
  try {
    const user = await getUser(ctx);
    const { data: proposal, error: proposalError } = await supabase
      .from('submissions')
      .select('id, bounty_id, freelancer_id')
      .eq('id', ctx.match[1])
      .maybeSingle();

    if (proposalError) throw proposalError;
    if (!proposal) return ctx.reply('Ця пропозиція вже недоступна.');

    const { data: project, error: projectError } = await supabase
      .from('bounties')
      .select('id, title, client_id, status')
      .eq('id', proposal.bounty_id)
      .maybeSingle();

    if (projectError) throw projectError;
    if (!project || project.client_id !== user.id) {
      return ctx.reply('Виконавця може обрати лише замовник проєкту.');
    }
    if (project.status !== 'open') return ctx.reply('Виконавця вже обрали або проєкт закрито.');

    const { data: winnerId, error } = await supabase.rpc('choose_bounty_winner', {
      p_bounty_id: project.id,
      p_submission_id: proposal.id,
      p_client_id: user.id
    });
    if (error) throw error;

    const freelancer = await userById(winnerId || proposal.freelancer_id);
    const client = await userById(project.client_id);
    await ctx.reply(
      '✅ Виконавця обрано. Проєкт перейшов у роботу.\n\n' +
      'Погодьте деталі й оплату напряму з виконавцем.',
      menu(ctx.from.id)
    );

    if (freelancer) {
      await notify(
        freelancer.telegram_id,
        '🎉 Вас обрали виконавцем проєкту «' + escapeHtml(project.title) + '».\n' +
        'Замовник: ' + telegramContact(client) + '\n' +
        'Узгодьте деталі й оплату напряму.'
      );
    }
    if (client && freelancer) {
      await notify(
        client.telegram_id,
        'Для проєкту «' + escapeHtml(project.title) + '» обрано виконавця: ' +
        telegramContact(freelancer) + '. Узгодьте деталі й оплату напряму.'
      );
    }
  } catch (error) {
    await reportError(ctx, 'Помилка вибору виконавця:', error);
  }
});

// Work delivery and review

bot.action('my_work', async (ctx) => {
  await answerCallback(ctx);
  try {
    const user = await getUser(ctx);
    const { data: projects, error } = await supabase
      .from('bounties')
      .select('id, title, budget, currency, status, updated_at')
      .eq('winner_id', user.id)
      .in('status', ['in_progress', 'review', 'completed'])
      .order('updated_at', { ascending: false })
      .limit(MAX_ITEMS);

    if (error) throw error;
    if (!projects?.length) {
      return showPage(ctx, '🛠 <b>Поки немає проєктів, де вас обрали.</b>', menu(ctx.from.id));
    }

    const rows = [];
    for (const project of projects) {
      if (project.status === 'in_progress') {
        rows.push([Markup.button.callback('📤 Здати: ' + String(project.title).slice(0, 24), 'deliver_' + project.id)]);
      }
      if (project.status === 'completed') {
        rows.push([Markup.button.callback('⭐ Відгук: ' + String(project.title).slice(0, 24), 'review_' + project.id)]);
      }
    }

    rows.push([Markup.button.callback('🔙 У меню', 'main_menu')]);

    const cards = projects.map((project) =>
      '<b>' + escapeHtml(project.title) + '</b>\n' +
      escapeHtml(money(project.budget, project.currency)) + ' · ' +
      escapeHtml(statusText(project.status))
    ).join('\n\n');
    await showPage(ctx, '<b>Моя робота</b>\n\n' + cards, Markup.inlineKeyboard(rows));
  } catch (error) {
    await reportError(ctx, 'Помилка завантаження робіт:', error);
  }
});

bot.action(/^deliver_(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  try {
    const user = await getUser(ctx);
    const { data: project, error } = await supabase
      .from('bounties')
      .select('id, title, winner_id, status')
      .eq('id', ctx.match[1])
      .maybeSingle();

    if (error) throw error;
    if (!project || project.winner_id !== user.id || project.status !== 'in_progress') {
      return ctx.reply('Цей проєкт не перебуває у вас в роботі.');
    }

    ctx.session.form = { type: 'delivery', step: 'url', projectId: project.id };
    await ctx.reply(
      'Надішліть посилання на готовий результат для проєкту «' + project.title + '».\n' +
      'Потрібне посилання з https:// або http://. Команда /cancel скасує дію.'
    );
  } catch (error) {
    await reportError(ctx, 'Помилка початку здачі роботи:', error);
  }
});

bot.action(/^review_delivery_(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  try {
    const user = await getUser(ctx);
    const { data: project, error } = await supabase
      .from('bounties')
      .select('id, title, client_id, winner_id, status')
      .eq('id', ctx.match[1])
      .maybeSingle();

    if (error) throw error;
    if (!project || project.client_id !== user.id || project.status !== 'review') {
      return ctx.reply('Результат недоступний або проєкт уже закрито.');
    }

    const { data: proposal, error: proposalError } = await supabase
      .from('submissions')
      .select('delivery_url, revision_note')
      .eq('bounty_id', project.id)
      .eq('freelancer_id', project.winner_id)
      .eq('is_winner', true)
      .maybeSingle();

    if (proposalError) throw proposalError;
    if (!proposal?.delivery_url) {
      return showPage(
        ctx,
        '⚠️ Для цього проєкту попередня версія бота не зберегла посилання на результат. Попросіть виконавця надіслати його ще раз.',
        Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Попросити надіслати результат', 'request_revision_' + project.id)],
          [Markup.button.callback('🔙 До моїх проєктів', 'my_projects')]
        ])
      );
    }

    let message = '<b>Результат за проєктом</b>\n' +
      escapeHtml(project.title) + '\n\n' +
      '<a href="' + escapeHtml(proposal.delivery_url) + '">Відкрити результат</a>';
    if (proposal.revision_note) {
      message += '\n\nКоментар до доопрацювання: ' + escapeHtml(proposal.revision_note);
    }

    await showPage(
      ctx,
      message,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Прийняти результат', 'approve_work_' + project.id)],
        [Markup.button.callback('🔄 Попросити доопрацювання', 'request_revision_' + project.id)],
        [Markup.button.callback('🔙 До моїх проєктів', 'my_projects')]
      ])
    );
  } catch (error) {
    await reportError(ctx, 'Помилка перегляду результату:', error);
  }
});

bot.action(/^approve_work_(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  try {
    const user = await getUser(ctx);
    const { data: project, error } = await supabase
      .from('bounties')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', ctx.match[1])
      .eq('client_id', user.id)
      .eq('status', 'review')
      .select('id, title, winner_id')
      .maybeSingle();

    if (error) throw error;
    if (!project) return ctx.reply('Проєкт уже закрито або він недоступний.');

    await ctx.reply('✅ Проєкт завершено. Дякуємо за підтвердження.', menu(ctx.from.id));
    const freelancer = await userById(project.winner_id);
    if (freelancer) {
      await notify(
        freelancer.telegram_id,
        '✅ Замовник підтвердив завершення проєкту «' + escapeHtml(project.title) + '».'
      );
    }

    await ctx.reply(
      'Бажаєте залишити відгук про співпрацю?',
      Markup.inlineKeyboard([
        [Markup.button.callback('⭐ Залишити відгук', 'review_' + project.id)]
      ])
    );
  } catch (error) {
    await reportError(ctx, 'Помилка підтвердження результату:', error);

  }
});

bot.action(/^request_revision_(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  ctx.session.form = { type: 'revision', step: 'note', projectId: ctx.match[1] };
  await ctx.reply('Коротко опишіть, що потрібно доопрацювати. Команда /cancel скасує дію.');
});

bot.action(/^review_(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  try {
    const user = await getUser(ctx);
    const { data: project, error } = await supabase
      .from('bounties')
      .select('id, title, client_id, winner_id, status')
      .eq('id', ctx.match[1])
      .maybeSingle();

    if (error) throw error;
    if (!project || project.status !== 'completed') {
      return ctx.reply('Відгук можна залишити після завершення проєкту.');
    }

    const clientSide = project.client_id === user.id;
    const freelancerSide = project.winner_id === user.id;
    if (!clientSide && !freelancerSide) {
      return ctx.reply('Відгуки можуть залишати лише учасники проєкту.');
    }

    const revieweeId = clientSide ? project.winner_id : project.client_id;
    const { data: existing, error: existingError } = await supabase
      .from('reviews')
      .select('id')
      .eq('bounty_id', project.id)
      .eq('reviewer_id', user.id)
      .maybeSingle();

    if (existingError) throw existingError;
    if (existing) return ctx.reply('Ви вже залишили відгук за цим проєктом.');

    ctx.session.form = {
      type: 'review',
      step: 'comment',
      projectId: project.id,
      revieweeId,
      rating: null
    };

    await ctx.reply(
      'Оцініть співпрацю за проєктом «' + project.title + '»:',
      Markup.inlineKeyboard([[
        Markup.button.callback('1 ⭐', 'rating_' + project.id + '_1'),
        Markup.button.callback('2 ⭐', 'rating_' + project.id + '_2'),
        Markup.button.callback('3 ⭐', 'rating_' + project.id + '_3'),
        Markup.button.callback('4 ⭐', 'rating_' + project.id + '_4'),
        Markup.button.callback('5 ⭐', 'rating_' + project.id + '_5')
      ]])
    );
  } catch (error) {
    await reportError(ctx, 'Помилка початку відгуку:', error);
  }
});

bot.action(/^rating_(\d+)_([1-5])$/, async (ctx) => {
  await answerCallback(ctx);
  const form = ctx.session.form;
  if (!form || form.type !== 'review' || String(form.projectId) !== ctx.match[1]) {
    return ctx.reply('Почніть відгук із картки завершеного проєкту.');
  }
  form.rating = Number(ctx.match[2]);
  await ctx.reply('Напишіть короткий відгук або надішліть /skip, щоб залишити лише оцінку.');
});

// Admin moderation

bot.action('admin_main', async (ctx) => {
  await answerCallback(ctx);
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ закрито.');
  await showPage(
    ctx,
    '⚙️ <b>Панель адміністратора</b>',
    Markup.inlineKeyboard([
      [Markup.button.callback('📝 Проєкти на перевірці', 'admin_pending')],
      [Markup.button.callback('🔙 Головне меню', 'main_menu')]
    ])
  );
});

bot.action(/^admin_pending(?:_(\d+))?$/, async (ctx) => {
  await answerCallback(ctx);
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ закрито.');
  try {
    const page = Math.max(0, Number(ctx.match[1] || 0));
    const { data: projects, error } = await supabase
      .from('bounties')
      .select('id, title, category, description, budget, currency, deadline, client_id', { count: 'exact' })
      .eq('status', 'pending_approval')
      .order('created_at', { ascending: true })
      .range(page * MAX_ITEMS, page * MAX_ITEMS + MAX_ITEMS - 1);

    if (error) throw error;
    if (!projects?.length) {
      return showPage(ctx, '📭 Немає проєктів на перевірці.', backMenu('admin_main'));
    }

    const rows = [];
    const cards = [];
    for (const project of projects) {
      const client = await userById(project.client_id);
      cards.push(
        '<b>' + escapeHtml(project.title) + '</b>\n' +
        escapeHtml(project.category || 'Інше') + ' · ' +
        escapeHtml(money(project.budget, project.currency)) + '\n' +
        'Замовник: ' + escapeHtml(userName(client)) + '\n' +
        escapeHtml(String(project.description).slice(0, 280))
      );
      rows.push([Markup.button.callback('✅ Опублікувати: ' + String(project.title).slice(0, 20), 'admin_publish_' + project.id)]);

      rows.push([Markup.button.callback('❌ Відхилити: ' + String(project.title).slice(0, 20), 'admin_reject_' + project.id)]);
    }
    const pageButtons = [];
    if (page > 0) pageButtons.push(Markup.button.callback('⬅️ Назад', 'admin_pending_' + (page - 1)));
    if ((page + 1) * MAX_ITEMS < Number(count || 0)) {
      pageButtons.push(Markup.button.callback('Далі ➡️', 'admin_pending_' + (page + 1)));
    }
    if (pageButtons.length) rows.push(pageButtons);
    rows.push([Markup.button.callback('🔙 Панель', 'admin_main')]);
    await showPage(ctx, '<b>Проєкти на перевірці</b>\n\n' + cards.join('\n\n'), Markup.inlineKeyboard(rows));
  } catch (error) {
    await reportError(ctx, 'Помилка модерації:', error);
  }
});

bot.action(/^admin_publish_(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ закрито.');
  try {
    const { data: project, error } = await supabase
      .from('bounties')
      .update({ status: 'open', updated_at: new Date().toISOString() })
      .eq('id', ctx.match[1])
      .eq('status', 'pending_approval')
      .select('id, title, client_id')
      .maybeSingle();

    if (error) throw error;
    if (!project) return ctx.reply('Проєкт уже оброблено.');
    await ctx.reply('✅ Проєкт опубліковано.', backMenu('admin_pending'));

    const client = await userById(project.client_id);
    if (client) {
      await notify(client.telegram_id, '✅ Ваш проєкт «' + escapeHtml(project.title) + '» пройшов модерацію та опублікований.');
    }
  } catch (error) {
    await reportError(ctx, 'Помилка публікації:', error);
  }
});

bot.action(/^admin_reject_(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  if (!isAdmin(ctx)) return ctx.reply('⛔ Доступ закрито.');
  try {
    const { data: project, error } = await supabase
      .from('bounties')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', ctx.match[1])
      .eq('status', 'pending_approval')
      .select('id, title, client_id')
      .maybeSingle();

    if (error) throw error;
    if (!project) return ctx.reply('Проєкт уже оброблено.');
    await ctx.reply('Проєкт відхилено.', backMenu('admin_pending'));

    const client = await userById(project.client_id);
    if (client) {
      await notify(client.telegram_id, 'Проєкт «' + escapeHtml(project.title) + '» не пройшов модерацію. Якщо це помилка, зверніться до підтримки.');
    }
  } catch (error) {
    await reportError(ctx, 'Помилка відхилення проєкту:', error);
  }
});

// Multi-step forms are kept in the bot session, so users do not need slash-command syntax.

async function finishReview(ctx, form) {
  if (!form.rating) {
    return ctx.reply('Спершу виберіть оцінку від 1 до 5 зірок.');
  }

  const user = await getUser(ctx);
  const { data: project, error: projectError } = await supabase
    .from('bounties')
    .select('id, title, client_id, winner_id, status')
    .eq('id', form.projectId)
    .maybeSingle();

  if (projectError) throw projectError;
  if (!project || project.status !== 'completed') {
    ctx.session.form = null;
    return ctx.reply('Залишити відгук можна лише після завершеного проєкту.');
  }

  const participant = project.client_id === user.id || project.winner_id === user.id;
  if (!participant || form.revieweeId === user.id) {
    ctx.session.form = null;
    return ctx.reply('Не вдалося перевірити учасників проєкту.');
  }

  const { error } = await supabase
    .from('reviews')
    .insert({
      bounty_id: project.id,
      reviewer_id: user.id,
      reviewee_id: form.revieweeId,
      rating: form.rating,
      comment: form.comment || null
    });

  if (error) throw error;
  ctx.session.form = null;
  await ctx.reply('Дякуємо за відгук! Він допоможе іншим учасникам.', menu(ctx.from.id));

  const reviewee = await userById(form.revieweeId);
  if (reviewee) {
    await notify(reviewee.telegram_id, '⭐ Вам залишили відгук за проєктом «' + escapeHtml(project.title) + '».');
  }
}

async function finishDelivery(ctx, form, url) {
  const user = await getUser(ctx);
  const { data: project, error: projectError } = await supabase
    .from('bounties')
    .select('id, title, client_id, winner_id, status')
    .eq('id', form.projectId)
    .maybeSingle();

  if (projectError) throw projectError;
  if (!project || project.winner_id !== user.id || project.status !== 'in_progress') {
    ctx.session.form = null;
    return ctx.reply('Цей проєкт уже не можна здати.');
  }


  const { error } = await supabase.rpc('submit_bounty_delivery', {
    p_bounty_id: project.id,
    p_freelancer_id: user.id,
    p_delivery_url: url
  });
  if (error) throw error;

  ctx.session.form = null;
  await ctx.reply('📦 Результат передано замовнику на перевірку.', menu(ctx.from.id));

  const client = await userById(project.client_id);
  if (client) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('👀 Перевірити результат', 'review_delivery_' + project.id)]
    ]).reply_markup;
    await notify(client.telegram_id, '📦 Виконавець передав результат за проєктом «' + escapeHtml(project.title) + '».', keyboard);
  }
}

async function finishRevision(ctx, form, note) {
  const user = await getUser(ctx);
  const { data: project, error: projectError } = await supabase
    .from('bounties')
    .select('id, title, client_id, winner_id, status')
    .eq('id', form.projectId)
    .maybeSingle();

  if (projectError) throw projectError;
  if (!project || project.client_id !== user.id || project.status !== 'review') {
    ctx.session.form = null;
    return ctx.reply('Запит на доопрацювання вже недоступний.');
  }

  const { error } = await supabase.rpc('request_bounty_revision', {
    p_bounty_id: project.id,
    p_client_id: user.id,
    p_note: note
  });
  if (error) throw error;
  ctx.session.form = null;
  await ctx.reply('Запит на доопрацювання відправлено виконавцю.', menu(ctx.from.id));

  const freelancer = await userById(project.winner_id);
  if (freelancer) {
    await notify(
      freelancer.telegram_id,
      '🔄 Замовник попросив доопрацювати проєкт «' + escapeHtml(project.title) + '»:\n\n' + escapeHtml(note)
    );
  }
}

bot.on('text', async (ctx) => {
  const text = messageText(ctx);
  const form = ctx.session.form;

  if (!form) {
    if (text.startsWith('/')) return ctx.reply('Скористайтеся меню або командою /help.', menu(ctx.from.id));
    return ctx.reply('Оберіть дію в меню 👇', menu(ctx.from.id));
  }

  if (text.toLowerCase() === '/skip') {
    if (form.type === 'proposal' && form.step === 'price') {
      form.proposedBudget = null;
      form.step = 'message';
      return ctx.reply('Опишіть, як виконаєте завдання і чому саме ви підходите (2–5 речень).');
    }
    if (form.type === 'proposal' && form.step === 'portfolio') {
      form.portfolioUrl = null;
      try {
        await saveProposal(ctx, form);
      } catch (error) {
        ctx.session.form = null;
        await reportError(ctx, 'Помилка збереження пропозиції:', error);
      }
      return;
    }
    if (form.type === 'review' && form.step === 'comment') {
      form.comment = null;
      try {
        await finishReview(ctx, form);
      } catch (error) {
        ctx.session.form = null;
        await reportError(ctx, 'Помилка збереження відгуку:', error);
      }
      return;
    }
  }

  if (form.type === 'create') {
    if (form.step === 'problem') {
      if (text.length < 10 || text.length > 1000) {
        return ctx.reply('Опишіть проблему у 10–1000 символах. Не додавайте паролі чи приватні дані клієнтів.');
      }
      form.problem = text;
      form.step = 'title';
      return ctx.reply('Крок 2 із 7. Коротко назвіть потрібний результат, наприклад: «Система обліку заявок».');
    }
    if (form.step === 'title') {
      if (text.length < 5 || text.length > 120) return ctx.reply('Назва має містити від 5 до 120 символів.');
      form.title = text;
      form.step = 'category';
      return ctx.reply('Крок 3 із 7. Оберіть напрям, надіславши номер. Якщо вагаєтеся — оберіть «Інше»; опис допоможе зрозуміти суть:\n1 — Дизайн\n2 — Фото та відео\n3 — Розробка та автоматизація\n4 — Маркетинг\n5 — Інше');
    }
    if (form.step === 'category') {
      const index = Number(text) - 1;
      if (!Number.isInteger(index) || !CATEGORIES[index]) return ctx.reply('Надішліть номер категорії від 1 до 5.');
      form.category = CATEGORIES[index];
      form.step = 'description';
      return ctx.reply('Крок 4 із 7. Опишіть, яким має бути готовий результат і що важливо врахувати. Від 20 до 2500 символів.');
    }
    if (form.step === 'description') {

      if (text.length < 20 || text.length > 2500) return ctx.reply('Опис має містити від 20 до 2500 символів.');
      form.description = 'Проблема / контекст: ' + form.problem + '\n\n' +
        'Очікуваний результат і важливі деталі: ' + text;
      form.step = 'budget';
      return ctx.reply('Крок 5 із 7. Укажіть бюджет числом, наприклад 5000 або 5000,50.');
    }
    if (form.step === 'budget') {
      const amount = parseMoney(text);
      if (!amount) return ctx.reply('Уведіть додатну суму з максимум двома цифрами після коми.');
      form.budget = amount;
      form.step = 'currency';
      return ctx.reply('Крок 6 із 7. Оберіть валюту: 1 — UAH, 2 — EUR, 3 — USD.');
    }
    if (form.step === 'currency') {
      const index = Number(text) - 1;
      if (!Number.isInteger(index) || !CURRENCIES[index]) return ctx.reply('Надішліть номер валюти від 1 до 3.');
      form.currency = CURRENCIES[index];
      form.step = 'deadline';
      return ctx.reply('Крок 7 із 7. Укажіть кінцевий термін у форматі ДД.ММ.РРРР, наприклад 30.11.2026.');
    }
    if (form.step === 'deadline') {
      if (!parseDeadline(text)) return ctx.reply('Укажіть майбутню дату у форматі ДД.ММ.РРРР.');
      form.deadline = text;
      try {
        await saveProject(ctx, form);
      } catch (error) {
        ctx.session.form = null;
        await reportError(ctx, 'Помилка створення проєкту:', error);
      }
      return;
    }
  }

  if (form.type === 'proposal') {
    if (form.step === 'price') {
      const amount = parseMoney(text);
      if (!amount) return ctx.reply('Уведіть свою ціну або надішліть /skip, щоб запропонувати бюджет проєкту.');
      form.proposedBudget = amount;
      form.step = 'message';
      return ctx.reply('Опишіть, як виконаєте завдання і чому саме ви підходите (2–5 речень).');
    }
    if (form.step === 'message') {
      if (text.length < 20 || text.length > 1200) return ctx.reply('Повідомлення має містити від 20 до 1200 символів.');
      form.message = text;
      form.step = 'portfolio';
      return ctx.reply('Надішліть посилання на портфоліо або приклад роботи, або введіть /skip.');
    }
    if (form.step === 'portfolio') {
      if (!isHttpUrl(text)) return ctx.reply('Потрібне посилання з https:// або http://, або надішліть /skip.');
      form.portfolioUrl = text;
      try {
        await saveProposal(ctx, form);
      } catch (error) {
        ctx.session.form = null;
        await reportError(ctx, 'Помилка збереження пропозиції:', error);
      }
      return;
    }
  }

  if (form.type === 'delivery' && form.step === 'url') {
    if (!isHttpUrl(text)) return ctx.reply('Потрібне посилання з https:// або http://.');
    try {
      await finishDelivery(ctx, form, text);
    } catch (error) {
      ctx.session.form = null;
      await reportError(ctx, 'Помилка передачі результату:', error);
    }
    return;
  }

  if (form.type === 'revision' && form.step === 'note') {
    if (text.length < 5 || text.length > 1000) return ctx.reply('Опишіть доопрацювання у 5–1000 символах.');
    try {
      await finishRevision(ctx, form, text);
    } catch (error) {
      ctx.session.form = null;
      await reportError(ctx, 'Помилка запиту доопрацювання:', error);
    }
    return;
  }

  if (form.type === 'review' && form.step === 'comment') {
    if (text.length > 800) return ctx.reply('Відгук має бути коротшим за 800 символів.');
    form.comment = text;
    try {
      await finishReview(ctx, form);
    } catch (error) {
      ctx.session.form = null;
      await reportError(ctx, 'Помилка збереження відгуку:', error);
    }
  }
});

bot.action('my_profile', async (ctx) => {
  await answerCallback(ctx);
  try {
    const user = await getUser(ctx);
    const { data: reviews, error } = await supabase
      .from('reviews')
      .select('rating')
      .eq('reviewee_id', user.id);

    if (error) throw error;
    const average = reviews?.length
      ? (reviews.reduce((sum, review) => sum + Number(review.rating), 0) / reviews.length).toFixed(1)
      : 'поки немає оцінок';

    await showPage(
      ctx,
      '<b>👤 Мій профіль</b>\n\n' +
      'Ім’я: ' + escapeHtml(user.first_name || 'не вказано') + '\n' +
      'Telegram: ' + (user.username ? '@' + escapeHtml(user.username) : 'не вказаний') + '\n' +
      'Оцінка: ' + escapeHtml(average) + '\n' +

      'Відгуків: ' + String(reviews?.length || 0),
      menu(ctx.from.id)
    );
  } catch (error) {
    await reportError(ctx, 'Помилка завантаження профілю:', error);
  }
});

bot.on('message', async (ctx) => {
  if (ctx.session?.form) {
    return ctx.reply('Зараз я очікую текст. Надішліть текст або скористайтеся /cancel.');
  }
  await ctx.reply('Оберіть дію в меню 👇', menu(ctx.from?.id || 0));
});

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT повинен бути числом від 1 до 65535.');
}

const healthServer = http.createServer((req, res) => {
  if (req.method !== 'GET' || !['/', '/health'].includes(req.url)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found.');
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Pry.it bot is running.');
});

bot.launch()
  .then(() => {
    console.log('Pry.it запущено.');
    healthServer.listen(port, '0.0.0.0', () => console.log('Health check слухає порт ' + port + '.'));
  })
  .catch((error) => {
    console.error('Не вдалося запустити Telegram-бота:', error);
    process.exitCode = 1;
  });

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  healthServer.close();
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  healthServer.close();
});


