import { eq } from "drizzle-orm";
import { db, pool } from "./client";
import { supportKbArticles } from "./schema";

// The support bot's starter help library (14 articles, from the frontend
// team's SUPPORT_BOT_ARTICLES.md). Amounts admins can change — withdrawal
// limits, fees, commission, recharge packs, VIP plans, gift prices — are
// deliberately not written here: the bot reads them live (get_current_rules),
// so an admin changing a value can never leave the bot quoting an old one.
//
// Idempotent: adds only articles whose title doesn't exist yet, and never
// touches one an admin has already edited. Run: npm run db:seed-support-articles

type Seed = { title: string; audience: "host" | "user" | "all"; content: string };

const ARTICLES: Seed[] = [
  {
    title: "Withdrawals: how and when you get paid",
    audience: "host",
    content: `To withdraw, your KYC must be approved and you need a payout method (bank account or UPI) in Settings → Payout details.

Go to Earnings → Withdraw, enter the amount and confirm. The confirm screen shows exactly what you will receive after the processing fee and TDS.

There is a minimum withdrawal amount and a limit on how many withdrawals you can make in a period. Larger withdrawals are checked manually by our team before they are paid. (The assistant looks up the current minimum, limit, fees and manual-check amount.)

Money reaches your bank in 2–3 business days.

You can follow every request in Settings → My Withdrawals, where each one also has an invoice.
If a withdrawal is rejected, check your bank or UPI details in Payout details and try again.

People may ask: "withdrawal pending", "money not received", "paisa nahi aaya", "payment kab aayega".`,
  },
  {
    title: "KYC verification",
    audience: "host",
    content: `KYC is needed before your first withdrawal.

Steps: upload a clear photo of a government ID (front and back) and add your payout details. The name and photo must be easy to read — blurry, cropped or expired documents are rejected.

Our team reviews every submission. You can see your status at any time in Settings → KYC Details.

If your KYC is rejected, the reason is shown in KYC Details. Fix the problem and submit again with the "Update KYC" button.

People may ask: "KYC rejected", "KYC pending", "verification kab hoga".`,
  },
  {
    title: "Beans, levels and your prices",
    audience: "host",
    content: `You earn beans from calls, gifts, messages and live streams. (The assistant looks up what a bean is worth when earned, and the payout rate when withdrawing.)

Everyone starts at Level 1. At Level 1 you can charge up to ₹30/min for video calls, ₹20/min for voice calls and ₹5 per message.

You move up one level for every 1,00,000 beans you earn. There are 20 levels. Each level raises your maximum video, voice and message price by ₹20.

Levels go up automatically and never go down. Withdrawing your beans does not lower your level.

You can charge less than your maximum in Settings → Rate settings. Leave a rate empty to always charge your level's price.`,
  },
  {
    title: "Call earnings and call quality",
    audience: "host",
    content: `Calls are charged per minute at the rate you had when the call started.
You earn your share after the platform commission. (The assistant looks up the current commission.)

Every call gets a quality band based on its length — by default:
- under 4 minutes: Bad
- 4 to 10 minutes: Good
- over 10 minutes: Excellent

A call ends automatically if the user's balance runs out.

Your totals are in Earnings and in the Daily report (online time, calls, gifts and other earnings for any day).`,
  },
  {
    title: "Gifts and live streams",
    audience: "host",
    content: `Users can send you gifts during calls, in chat and while you are live. You receive beans for every gift, after the platform commission.

During a call you can tap "Ask gift" to suggest a gift, with an optional short note.
Gifts sent while you are live also appear in your live comments with the sender's name.

Gift prices: see the gift list in the app. (The assistant can look up the current prices.)

People may ask: "gift not received", "gift beans kitne milte hain".`,
  },
  {
    title: "Going online, live and availability",
    audience: "host",
    content: `Use the Online toggle on Home to start receiving calls. When you are offline, users can't call you.

Settings → Availability:
- Auto-accept calls connects incoming calls without tapping Accept.
- "Voice calls only after 12 AM" turns off video calls late at night.

To go live, open Live, choose your settings and tap Go live. Viewers can comment and send gifts.`,
  },
  {
    title: "Recharge and talktime balance",
    audience: "user",
    content: `Add money from Wallet → Add balance. Payments are made securely through Cashfree.

Recharge packs: see Wallet → Add balance for the current packs and offers. (The assistant can look up the current packs.)

If you paid but the balance was not added, it usually updates within a few minutes. If it still hasn't, contact support with the payment ID from your bank or UPI app.

People may ask: "recharge not added", "paisa kat gaya balance nahi aaya", "payment failed".`,
  },
  {
    title: "How calls and messages are charged",
    audience: "user",
    content: `Each creator sets their own price for video calls, voice calls and messages. You can see the price before you call or message.

Calls are charged per minute while you are connected. You get a low-balance warning, and the call ends when your balance runs out.

Each message to a creator costs that creator's message price. A photo costs the same as a message.

If a call dropped and you think you were charged wrongly, our team will check it — support will pass this to a person.`,
  },
  {
    title: "VIP subscription",
    audience: "user",
    content: `VIP gives you a discount on every call while it is active. (The assistant looks up the current discount and plans.)

Plans: see the VIP screen for the current plans and prices.

VIP does not charge you again automatically. To keep VIP, buy a plan again — buying before your plan ends adds the new time on top. If you cancel, you keep VIP until the end of the period you paid for.

You can see your plan in Settings → Active Subscriptions.`,
  },
  {
    title: "Sending gifts",
    audience: "user",
    content: `You can send a gift to a creator during a call, in chat or while they are live. Tap the gift button and choose a gift. The price is paid from your balance.

After you send a gift in chat, a "Gift sent" card appears in the conversation.

If you think a gift was charged wrongly or sent by mistake, support will pass this to a person to check.`,
  },
  {
    title: "Age verification and your account",
    audience: "user",
    content: `You must be 18 or older to use the app, and age verification is required when you sign up.

If your account is restricted, it is because of a safety review. Support will pass these questions to a person.

To delete your account, go to Settings → Delete Account. Deleting is permanent and you can't sign in again afterwards, so any balance left in your wallet can't be used after that. Use your balance first, or contact support before deleting if you have questions about it.`,
  },
  {
    title: "Safety: blocking and reporting",
    audience: "all",
    content: `You can block or report someone from the call screen, the chat or their profile.

People you block can't call or message you. You can unblock them in Settings → Blocked users.

Every report is reviewed by our team. Support cannot promise what the outcome will be.

Recording calls or taking screenshots is not allowed. Nudity, or asking to meet or share contact details outside the app, leads to removal or a ban. Photos sent in chat are checked automatically.`,
  },
  {
    title: "Referrals",
    audience: "all",
    content: `Your referral code is in Settings → Refer and Earn. Use "Share link" — when a friend opens it, your code is filled in on the sign-up screen. They can also type it under "Have a referral code?".

A code only counts when it is used to create a new account.

Referral rewards are coming soon. Referrals made now are already tracked.`,
  },
  {
    title: "App problems: camera, call quality, login",
    audience: "all",
    content: `Camera or mic not working: allow camera and microphone permission for the app in your phone settings, then reopen the app.

Black video or poor quality: use Wi-Fi or a strong 4G/5G signal, keep the app open during the call, and face a light source.

OTP not received: check the number, wait 30 seconds and tap Resend.

If the problem continues, tell support your phone model and what you see.`,
  },
];

async function seedSupportArticles(): Promise<void> {
  let added = 0;
  for (const article of ARTICLES) {
    const [existing] = await db.select({ id: supportKbArticles.id }).from(supportKbArticles).where(eq(supportKbArticles.title, article.title)).limit(1);
    if (existing) continue;
    await db.insert(supportKbArticles).values({ ...article, active: true });
    added += 1;
  }
  console.log(`Support articles: ${added} added, ${ARTICLES.length - added} already present`);
}

seedSupportArticles()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
