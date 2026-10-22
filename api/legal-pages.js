'use strict';

// Public legal pages. Retention figures come from RETENTION_POLICY so the promise and the sweep cannot drift.

const { RETENTION_POLICY } = require('./services/data-retention');

const COMPANY = 'Intuitive Devices';
const APP_NAME = 'Adam';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@heyintuitive.com';
const SECURITY_EMAIL = process.env.SECURITY_EMAIL || 'security@heyintuitive.com';
const PRIVACY_UPDATED = '22 October 2026';
const TERMS_UPDATED = '22 October 2026';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mail = (address = SUPPORT_EMAIL) => `<a href="mailto:${escapeHtml(address)}">${escapeHtml(address)}</a>`;

function page(title, body) {
  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)} · ${APP_NAME}</title>
  <style>
    :root{--bg:#faf8f5;--ink:#1b1917;--muted:#5d5751;--rule:#e4ded6;--link:#a8452f}
    @media (prefers-color-scheme:dark){:root{--bg:#0f0e0d;--ink:#f1ece6;--muted:#a59d94;--rule:#2a2724;--link:#e97961}}
    body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:720px;margin:0 auto;padding:48px 20px 80px}
    h1{font-size:34px;line-height:1.15;margin:0 0 8px}
    h2{font-size:20px;margin:36px 0 8px}
    p,li{color:var(--ink)}
    li{margin:4px 0}
    .meta{color:var(--muted);font-size:14px;margin:0 0 28px}
    a{color:var(--link)}
    table{border-collapse:collapse;width:100%;font-size:15px}
    th,td{text-align:left;vertical-align:top;padding:8px 10px 8px 0;border-bottom:1px solid var(--rule)}
    th{color:var(--muted);font-weight:600}
    footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--rule);color:var(--muted);font-size:14px}
  </style>
</head>
<body><main>${body}
<footer>${COMPANY} · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Use</a> · <a href="/support">Support</a></footer>
</main></body>
</html>`;
}

function retentionRows() {
  return Object.values(RETENTION_POLICY).map((rule) => `<li>${escapeHtml(rule.label)}</li>`).join('\n      ');
}

function privacyPage() {
  return page('Privacy Policy', `
    <h1>Privacy Policy</h1>
    <p class="meta">Last updated ${PRIVACY_UPDATED}</p>

    <p>${APP_NAME} is a personal assistant app made by ${COMPANY} ("we", "us"). It helps you get things done: read and draft messages, manage your calendar, search, book, and keep track of what needs doing. This policy explains what personal data we handle, why, who else sees it, and the choices you have.</p>
    <p>${COMPANY} is the controller of your personal data under UK GDPR. You can reach us at ${mail()}.</p>

    <h2>The short version</h2>
    <ul>
      <li>We don't sell your data and we don't show ads.</li>
      <li>We don't track you across other apps or websites.</li>
      <li>You choose which permissions and accounts to connect. Each one can be switched off again.</li>
      <li>You can export or delete everything from inside the app.</li>
    </ul>

    <h2>What we collect, and why</h2>
    <table>
      <tr><th>Data</th><th>Why we need it</th></tr>
      <tr><td>Account details: email address, name, and a hashed password</td><td>To create your account and keep it secure.</td></tr>
      <tr><td>Messages you send and the replies you get, including voice you dictate</td><td>To do what you ask and to keep the conversation in context. Dictated audio is sent for transcription and the recording itself is not kept by us.</td></tr>
      <tr><td>Memories: preferences and facts you ask ${APP_NAME} to keep, or that come up repeatedly</td><td>So you don't have to repeat yourself. You can view and delete them.</td></tr>
      <tr><td>Location, when you allow it</td><td>For directions, nearby suggestions, travel, and reminders tied to a place such as arriving home.</td></tr>
      <tr><td>Contacts, calendar and reminders, when you allow them</td><td>To address messages to the right person and to create events and reminders you ask for.</td></tr>
      <tr><td>Health data (heart rate, sleep, steps), when you allow it</td><td>Only to answer your questions and run health alerts that you set up. We do not use health data for advertising or share it with data brokers.</td></tr>
      <tr><td>Photos you attach, and photos you let ${APP_NAME} learn from</td><td>Photos you attach are sent with your message. If you turn on learning from your photos, they are read on your iPhone and only short notes about them are kept, not the pictures.</td></tr>
      <tr><td>Sounds around the home, if you turn on sound detection</td><td>Sounds are recognised on your iPhone. Only the label of a recognised sound (for example "smoke alarm") and the time are sent to us, not audio.</td></tr>
      <tr><td>Email, calendar and files from accounts you connect (Google, Microsoft, and similar)</td><td>To read, search and act on them when you ask or when you have asked ${APP_NAME} to watch for something. Sign-in tokens for these accounts are encrypted.</td></tr>
      <tr><td>Documents and saved logins you give ${APP_NAME}, such as a form or a website sign-in</td><td>To fill in forms and sign in on your behalf. They are kept in private storage and used only for tasks you ask for.</td></tr>
      <tr><td>Payment card details, if you choose to save a card for purchases</td><td>To complete purchases you approve. A payment is never made without your confirmation of the exact amount.</td></tr>
      <tr><td>Device details: push notification token, time zone, app version</td><td>To send you notifications you have allowed and to fix problems.</td></tr>
      <tr><td>Error reports and basic diagnostics</td><td>To find and fix faults. These do not include the content of your messages.</td></tr>
    </table>

    <h2>Our lawful bases</h2>
    <ul>
      <li><strong>Contract:</strong> running your account and the features you ask for.</li>
      <li><strong>Consent:</strong> location, contacts, calendar, health, photos, microphone and notifications, and connecting third-party accounts. You can withdraw consent at any time in your iPhone's Settings or in ${APP_NAME}; withdrawing does not affect what happened before. Health data is handled only with your explicit consent.</li>
      <li><strong>Legitimate interests:</strong> keeping the service secure, preventing abuse, and fixing faults.</li>
      <li><strong>Legal obligation:</strong> where the law requires us to keep or disclose information.</li>
    </ul>

    <h2>Who else handles your data</h2>
    <p>We use service providers to run ${APP_NAME}. They act on our instructions and only receive what they need.</p>
    <table>
      <tr><th>Provider</th><th>What they do</th></tr>
      <tr><td>OpenAI</td><td>Language processing for understanding and replying to your messages, speech-to-text, and text-to-speech. The text and context needed for a request are sent to them. We use their business API, under which data is not used to train their models.</td></tr>
      <tr><td>Supabase</td><td>Database and file storage.</td></tr>
      <tr><td>Fly.io</td><td>Server hosting (London).</td></tr>
      <tr><td>Apple</td><td>Push notifications, and Maps and Music when you use them.</td></tr>
      <tr><td>Sentry</td><td>Error reporting.</td></tr>
      <tr><td>Google, Microsoft, Slack, GitHub, Strava, Telegram</td><td>Only for the accounts you choose to connect, to carry out your requests.</td></tr>
      <tr><td>Twilio</td><td>Sending and receiving text messages and calls on your behalf, where you use that feature.</td></tr>
      <tr><td>Stripe</td><td>Handling a saved payment card, where you use that feature.</td></tr>
      <tr><td>Travel, address and booking providers</td><td>When you ask for flights, stays or an address lookup, the details of that search (such as dates, places or a postcode) are sent to the relevant provider.</td></tr>
      <tr><td>Websites you ask ${APP_NAME} to use</td><td>When ${APP_NAME} browses or buys for you, the details needed (such as your delivery address or name) are entered on that website, as if you had typed them.</td></tr>
    </table>
    <p>Some of these providers are outside the UK, including in the United States. Where that happens we rely on the safeguards UK law requires, such as approved contract terms.</p>
    <p>We may disclose information if the law or a court requires it, or to protect people from harm. If our business is ever sold or merged, your data would move with it under this policy.</p>

    <h2>How long we keep it</h2>
    <ul>
      ${retentionRows()}
      <li>Memories, your account and connected accounts: until you delete them or your account.</li>
    </ul>

    <h2>Your choices and rights</h2>
    <ul>
      <li><strong>Export:</strong> Profile, then "Your data", then "Export my data".</li>
      <li><strong>Delete your account and everything in it:</strong> Profile, then "Sign out and delete", then "Delete account". This removes your messages, memories, connected account tokens, files and saved logins.</li>
      <li><strong>Memories and connected accounts:</strong> view, edit and remove them in the app.</li>
      <li><strong>Permissions:</strong> change any of them in your iPhone's Settings.</li>
    </ul>
    <p>Under UK GDPR you also have the right to access your data, correct it, have it erased, restrict or object to how we use it, and receive it in a portable form. To use a right that the app doesn't cover, email ${mail()}; we reply within one month. If you are unhappy with how we handle your data you can complain to the Information Commissioner's Office at <a href="https://ico.org.uk">ico.org.uk</a>, though we'd like the chance to put it right first.</p>

    <h2>Security</h2>
    <p>Data is encrypted in transit. Sign-in tokens for connected accounts, saved cards and the text of your documents are encrypted at rest, and everything is held in access-controlled databases and private storage. Money-moving and irreversible actions need your explicit approval. If a breach affects your data and the law requires it, we will tell you and the ICO within 72 hours of becoming aware of it. To report a security issue, email ${mail(SECURITY_EMAIL)}.</p>

    <h2>Children</h2>
    <p>${APP_NAME} is not intended for anyone under 13, and we don't knowingly collect data from them. If you think a child has an account, email us and we will delete it.</p>

    <h2>Changes</h2>
    <p>If we change this policy in a way that matters, we will tell you in the app before it takes effect. The date at the top shows the latest version.</p>

    <h2>Contact</h2>
    <p>${COMPANY}<br>${mail()}</p>
  `);
}

function termsPage() {
  return page('Terms of Use', `
    <h1>Terms of Use</h1>
    <p class="meta">Last updated ${TERMS_UPDATED}</p>

    <p>These terms are between you and ${COMPANY} ("we", "us") and cover your use of the ${APP_NAME} app and its related services. By creating an account or using ${APP_NAME} you agree to them. Our <a href="/privacy">Privacy Policy</a> explains how we handle your data.</p>

    <h2>What ${APP_NAME} is</h2>
    <p>${APP_NAME} is a personal assistant. You tell it what you want done and, with the access you give it, it can read and draft messages, manage your calendar and reminders, search, make bookings, and work on websites and apps for you. ${APP_NAME} is free to use. We don't charge a subscription, and no feature requires payment to us.</p>

    <h2>Your account</h2>
    <ul>
      <li>You must be at least 13 years old, and old enough in your country to enter into this agreement.</li>
      <li>Give accurate details, keep your password private, and tell us if you think someone else has used your account.</li>
      <li>You are responsible for activity on your account, including what ${APP_NAME} does on your behalf with permissions you have granted.</li>
    </ul>

    <h2>Actions taken for you</h2>
    <ul>
      <li>${APP_NAME} asks for your approval before spending money, sending certain messages, or making changes that are hard to undo. Check what you are approving, including amounts, recipients and dates.</li>
      <li>${APP_NAME} can make mistakes. It may misunderstand a request, misread a web page, or act on out-of-date information. Check anything important before relying on it.</li>
      <li>Purchases and bookings are contracts between you and the seller or provider, not us. Their terms, prices, delivery and refund policies apply, and we are not the seller.</li>
      <li>You must have the right to use any account, card, document or website you ask ${APP_NAME} to use, and you must follow the terms of those services.</li>
    </ul>

    <h2>Acceptable use</h2>
    <p>You agree not to use ${APP_NAME} to:</p>
    <ul>
      <li>break the law or help anyone else do so;</li>
      <li>send spam, harass or deceive people, or impersonate someone;</li>
      <li>access accounts, data or systems that are not yours or that you are not allowed to use;</li>
      <li>try to break, overload, reverse engineer or get around the safeguards of the service;</li>
      <li>use it in a way that could harm other people, our systems, or the services it connects to.</li>
    </ul>
    <p>We may limit or suspend access if you break these terms or put the service or others at risk.</p>

    <h2>Third-party services</h2>
    <p>${APP_NAME} works with services we don't control, such as Google, Microsoft, airlines, shops and websites. They can change, be unavailable, or refuse automated access, and ${APP_NAME} may not be able to complete a task as a result. We aren't responsible for those services.</p>

    <h2>Your content</h2>
    <p>You own what you put into ${APP_NAME}. You give us permission to store and process it as needed to run the service for you, as described in the Privacy Policy. That permission ends when you delete the content or your account.</p>

    <h2>Our rights</h2>
    <p>${APP_NAME}, its software, design and brand belong to ${COMPANY}. You may use the app for your own personal use; you may not copy, sell or reuse it beyond that.</p>

    <h2>Availability and changes</h2>
    <p>We work to keep ${APP_NAME} running but can't promise it will always be available or error free. We may change or remove features, and we may update these terms. If a change matters, we will tell you in the app before it takes effect. If you carry on using ${APP_NAME} after that, you accept the update; if you don't agree, you can delete your account.</p>

    <h2>Ending your use</h2>
    <p>You can stop at any time and delete your account in the app (Profile, then "Sign out and delete", then "Delete account"). We may close an account that breaks these terms or has been unused for a long time, and will tell you where we can.</p>

    <h2>Our responsibility</h2>
    <p>Nothing in these terms limits our liability for death or personal injury caused by our negligence, for fraud, or for anything else the law doesn't allow us to limit, and your legal rights as a consumer are not affected.</p>
    <p>Subject to that, ${APP_NAME} is provided "as is" because it is free. We are not liable for losses that were not a foreseeable result of our breach, for business or lost profit losses (the app is for personal use), or for losses caused by third-party services, by actions you approved, or by information you didn't check. Our total liability to you for anything connected with the service is limited to £100.</p>

    <h2>Disputes and governing law</h2>
    <p>These terms are governed by the laws of England and Wales. If you live in Scotland or Northern Ireland you can also bring a claim in your local courts, and you keep any mandatory consumer protections of the country where you live. If something goes wrong, please contact ${mail()} first so we can try to fix it.</p>

    <h2>Contact</h2>
    <p>${COMPANY}<br>${mail()}</p>
  `);
}

function supportPage() {
  return page('Support', `
    <h1>${APP_NAME} Support</h1>
    <p class="meta">Made by ${COMPANY}</p>
    <p>Email ${mail()}. We usually reply within two working days. For a security problem, write to ${mail(SECURITY_EMAIL)} instead.</p>
    <p>When you write, it helps to include your iPhone model, the app version (Profile, bottom of the page), roughly when it happened, and what you asked ${APP_NAME} to do. Please don't send passwords or sign-in codes.</p>

    <h2>Delete your account and data</h2>
    <ol>
      <li>Open ${APP_NAME} and go to Profile.</li>
      <li>Under "Sign out and delete", tap "Delete account" and confirm.</li>
    </ol>
    <p>This permanently removes your messages, memories, connected accounts, files and saved logins. If you can't get into the app, email ${mail()} from the address you registered with and put "Delete my account" in the subject.</p>

    <h2>Get a copy of your data</h2>
    <p>Profile, then "Your data", then "Export my data".</p>

    <h2>Common questions</h2>
    <h2 style="font-size:17px;margin-top:20px">How do I connect Gmail or my calendar?</h2>
    <p>Open Connections, choose the service, and sign in. ${APP_NAME} only reads your email when you ask or when you've asked it to watch for something. You can disconnect at any time from the same screen.</p>
    <h2 style="font-size:17px;margin-top:20px">What does ${APP_NAME} remember?</h2>
    <p>Preferences and facts you ask it to keep, or that come up repeatedly. You can see, edit and delete them in the app.</p>
    <h2 style="font-size:17px;margin-top:20px">Does it cost anything?</h2>
    <p>No. ${APP_NAME} is free and has no subscription.</p>
    <h2 style="font-size:17px;margin-top:20px">Will it spend my money without asking?</h2>
    <p>No. It asks you to approve the exact amount before any payment, and it re-reads the amount from the page before it pays.</p>
    <h2 style="font-size:17px;margin-top:20px">I'm not getting notifications.</h2>
    <p>Check Settings, then Notifications, then ${APP_NAME} on your iPhone, and that notifications are switched on inside ${APP_NAME}. If they still don't arrive, email us.</p>
  `);
}

module.exports = { privacyPage, termsPage, supportPage, COMPANY, SUPPORT_EMAIL };
