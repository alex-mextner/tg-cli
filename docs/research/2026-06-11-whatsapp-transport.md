# WhatsApp as a Companion Transport for `tg` — Research (2026-06-11)

> Research spike: can WhatsApp replace/augment Telegram as the `tg` notification
> surface (agents push reports + questions, user replies, Q→buttons)? What breaks,
> and how to work around it. Sources are linked inline at the end.

## Executive summary

WhatsApp can technically replicate the core `tg` loop — agent pushes a
status/question, user taps a button to reply — but with friction at every layer.
The blocking issues:

1. **No custom inline emoji at all** (Telegram's per-agent branded emoji has no
   WhatsApp equivalent).
2. **The 24-hour session window** makes dynamic buttons unavailable after user
   silence — a fundamentally different model from Telegram's stateless bot.
3. **Cloud API is webhook-only** — needs a permanently reachable public HTTPS
   endpoint (Telegram `getUpdates` polling needs zero infra).
4. **Template button labels are static** — can't encode a dynamic permission
   question into a button outside the 24h window.
5. **Unofficial libs (Baileys / whatsapp-web.js) have interactive messages
   server-side deprecated** on the Web-MD protocol as of mid-2026 — the
   `Q→buttons` feature would simply not work on that path.

None is a showstopper alone; together they demand a non-trivial shim layer that
Telegram never needed. **Add WhatsApp only if explicitly wanted; it is not a
drop-in replacement.** If added: Cloud API via Graph API directly (no BSP), not
Baileys.

## 1. Custom emoji — impossible

WhatsApp supports only standard Unicode emoji (Unicode 17.0 as of early 2026).
There is **no** analogue to Telegram's uploadable custom emoji sets
(`messageEntityCustomEmoji`, inline `document_id`). Stickers exist (WebP,
512×512, ≤100 KB static / ≤500 KB animated) but are always **standalone
messages** — they cannot be embedded inline in text, which breaks the
one-message-per-report flow.

**Fallback:** lead each message with a fixed per-agent Unicode emoji + bold agent
name: `🔧 *build-agent*`. Functional, not branded the same way.

## 2. API options

### Cloud API (official, Meta-hosted) — recommended path
- **Auth/setup:** Meta developer account + Business Portfolio + a phone number.
  Personal number reusable via **Coexistence** (GA since Feb 2025 — run consumer
  app + Cloud API on the same number, no deletion). Payment method required.
- **Business verification:** not required to start; unverified = 250
  business-initiated conversations / 24h (never hit at personal scale).
- **Direct Graph API, no BSP:** `POST https://graph.facebook.com/v21.0/{phone-id}/messages`
  with a Bearer token. No middleman, no seat fee, only Meta's per-message rates.
- **Pricing:** ~$0.004/msg US base for Utility templates; ~3,000 msg/month ≈
  $12/month at zero-markup direct access. Service messages (inside an open
  user-initiated window) are free.
- **Rate limits:** 80 msg/s default (irrelevant for personal use).

### Baileys / whatsapp-web.js (unofficial) — avoid for this tool
- QR-pair a WhatsApp Web session; no business account.
- **Ban risk** is real (ToS violation regardless of volume; 2–8 week typical
  detection window). Losing your primary number is a non-trivial personal cost.
- **Interactive buttons/lists are broken/deprecated** on Web-MD as of Apr 2026
  ([Baileys #2465]) — no library update can fix a server-side deprecation.
- Viable only for raw text send/receive. **Dead end for `Q→buttons`.**

## 3. Formatting — proprietary, not HTML

| Format | Syntax |
|---|---|
| Bold | `*text*` (single asterisk) |
| Italic | `_text_` |
| Strikethrough | `~text~` |
| Monospace block | ` ```text``` ` |
| Inline code | `` `text` `` |
| Bullet / numbered list | `- item` / `1. item` |
| Block quote | `> text` (Cloud API v18+) |

HTML renders as literal text. Bold+italic combine (`*_text_*`); monospace can't
combine. No inline hyperlink text — only plain URLs (preview card). Template body
≤1,024 chars; free-form ≤4,096.

## 4. Interactive buttons — the Q→buttons crux

- **Inside 24h window:** free-form **interactive reply buttons**, fully dynamic
  labels, **max 3 buttons × 20 chars**; list messages up to 10 rows. No template
  approval. This covers the common case (agent triggered by a recent user action).
- **Outside 24h window:** must use a **pre-approved template**; **button labels
  are static** (fixed at template creation). Up to 20 `{{var}}` placeholders in
  the body but **not** in button labels.

**Workaround for out-of-window Q→buttons:** one generic approved Utility template
`"{{1}}"` with static buttons `Option 1/2/3`; the dynamic question + option
meanings go in the body variable; user taps a number. Or drop buttons entirely
and parse a numbered text reply ("Reply 1 for Allow, 2 for Deny"). Keep the
window open with a daily user `/ping` to stay on free-form buttons most of the time.

## 5. Media (Cloud API)

| Type | Max | Notes |
|---|---|---|
| Image | 5 MB | caption supported |
| Document/file | 100 MB | caption supported |
| Audio | 16 MB | |
| Video | 16 MB | |
| Sticker | 100 KB static / 500 KB animated | WebP 512², standalone only |

Out-of-window media needs a template with a media header (pre-approved).

## 6. Receiving inbound — webhook only

- Needs a **permanently reachable public HTTPS endpoint** with valid TLS: echo
  `hub.challenge` on GET verify, respond 200 to POST within 5–10 s. **No
  long-polling alternative** (unlike Telegram `getUpdates`).
- Meta retries with backoff up to **7 days**, then drops (no dead-letter).
- Dev: **Cloudflare Tunnel** (free, named tunnel, custom subdomain, no expiry) is
  the recommended always-on path; ngrok sometimes flagged. Means a persistent
  `cloudflared` process (launchd plist on macOS / systemd on Linux).

## 7. Problems vs Telegram → workarounds

| # | Problem | Severity | Workaround |
|---|---|---|---|
| 1 | No custom inline emoji | Hard (branding) | Fixed Unicode emoji + `*AgentName*` |
| 2 | 24h window gates dynamic buttons | High | Generic approved Utility template w/ static `Option N` buttons; daily `/ping` to keep window open |
| 3 | Static template button labels | Medium | Numbered labels; semantics in body `{{var}}` |
| 4 | Webhook needs always-on HTTPS | Medium | Cloudflare Tunnel free tier + launchd/systemd |
| 5 | Template approval latency | Low–med | Pre-approve one generic `agent_question` template at setup |
| 6 | Per-message cost | Low | ~$12/mo at heavy use; keep session open for free service msgs |
| 7 | No inline hyperlink text | Low | Plain URLs (preview card) |
| 8 | Baileys buttons broken mid-2026 | High (if unofficial) | Use Cloud API only |

## 8. Bottom line

- **Worth adding?** Only if WhatsApp is explicitly wanted as the surface. Addable,
  not drop-in.
- **Path:** Cloud API via Graph API directly (official, no ban risk, persistent,
  cheaper than BSP). **Not Baileys** — buttons are dead there.
- **Unavoidable compromises vs Telegram:** no branded emoji (Unicode only);
  out-of-window buttons need static-label templates + numbered indirection;
  always-on webhook tunnel required; ~$12/mo at heavy use; one-time business
  account setup.
- **Implementation sketch:** register WA Business number (Coexistence) → Graph API
  direct → Cloudflare Tunnel for receive → one generic Utility template for
  out-of-window prompts → free-form interactive reply buttons in-window (covers
  most real usage).

## Sources

Meta: [Cloud API Get Started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started),
[Interactive Messages](https://developers.facebook.com/docs/whatsapp/guides/interactive-messages/),
[Reply Buttons](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages/),
[Templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/template-messages/),
[Stickers](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/sticker-messages/).
Telegram: [Custom Emoji API](https://core.telegram.org/api/custom-emoji),
[messageEntityCustomEmoji](https://core.telegram.org/constructor/messageEntityCustomEmoji).
Baileys: [repo](https://github.com/WhiskeySockets/Baileys),
[#2465 list messages broken Apr 2026](https://github.com/WhiskeySockets/Baileys/issues/2465).
Ban risk: [Kraya-AI 2026](https://blog.kraya-ai.com/whatsapp-automation-ban-risk),
[Pallysystems Dec 2025](https://blog.pallysystems.com/2025/12/04/whatsapp-automation-using-baileys-js-a-complete-guide/).
Formatting: [WA.expert](https://wa.expert/pages/whatsapp-message-format-guide),
[WhatsApp Help](https://faq.whatsapp.com/539178204879377/).
Buttons: [Twilio](https://www.twilio.com/docs/whatsapp/buttons),
[QuickReply template buttons](https://docs.quickreply.ai/product-modules/templates/whatsapp-templates/concepts/template-button-types).
Pricing: [Blueticks 2026](https://blueticks.co/blog/whatsapp-business-api-pricing-2026),
[Respond.io](https://respond.io/blog/whatsapp-business-api-pricing).
Webhooks: [Hookdeck](https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices),
[WASenderAPI 2025](https://wasenderapi.com/blog/how-to-receive-whatsapp-messages-via-webhook-the-ultimate-2025-guide),
[Cloudflare Worker template](https://github.com/depombo/whatsapp-api-cf-worker).
Coexistence: [chakrahq](https://chakrahq.com/article/whatsapp-coexistence-business-app-register-cloud-api/).
Media limits: [DMly.io](https://dmly.io/whatsapp-file-size-guide/).
