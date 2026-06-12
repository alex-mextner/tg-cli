# tg-cli — WhatsApp companion transport (item 6, implementation spec)

Repo: `~/.files/repos/tg-cli`. Promotes the research spike
(`docs/research/2026-06-11-whatsapp-transport.md`) into an implementation plan.
**Status: spec only — not built.** It cannot be implemented or tested without the
user's Meta Business assets (phone number, Cloud API token, an always-on webhook
host), so this documents the design and the explicit trade-offs to decide before
writing code.

## Decision recap (from research)

- **Official Cloud API via Graph API directly** (no BSP, no Baileys — Baileys'
  interactive buttons are server-side-deprecated as of mid-2026, a dead end for
  Q→buttons).
- **Add only on explicit opt-in.** WhatsApp is NOT a drop-in for Telegram: no
  custom inline emoji, a 24-hour session window that gates dynamic buttons, and a
  webhook-only inbound path. It is a *companion* surface, never the default.

## North star

A `--transport whatsapp` (and `control.transport: whatsapp`) that reuses the
`tg` outbound voice and the `tg-ctl` inbound loop, swapping only the wire format.
Telegram remains the default and the reference implementation.

## Architecture fit

Introduce a small **Transport interface** both surfaces target, so the bulk of
`tg`/`tg-ctl` (SendPlan, auto-attach, autolink, inject, discovery) is unchanged:

```
interface ChatTransport {
  sendText(text, opts): Promise<{ messageId }>
  sendMedia(kind, items, caption): Promise<...>
  sendButtons(prompt, buttons): Promise<{ messageId }>   // q→buttons / /agent
  receive(): AsyncIterable<InboundEvent>                 // poll (TG) | webhook (WA)
  ack/edit/react(...)                                     // best-effort, no-op on WA where absent
}
```

- Telegram transport = today's `botPost`/`getUpdates` code behind the interface.
- WhatsApp transport = Graph API calls + a webhook receiver (below).

The render layer must branch on transport capability, NOT assume Telegram HTML.

## Outbound (Graph API)

- `POST https://graph.facebook.com/v21.0/{phone-id}/messages` with a Bearer
  token. Text, image (≤5 MB), document (≤100 MB) with captions.
- **Formatting shim**: WhatsApp uses `*bold*`, `_italic_`, `~strike~`,
  ` ```mono``` `, `> quote` — NOT HTML and NOT Telegram entities. A
  `renderForWhatsApp(plan)` converts the SendPlan's HTML/markup to WA markup and
  **drops**: custom emoji (→ fixed per-agent Unicode emoji + `*AgentName*`),
  inline hyperlink text (→ plain URLs; autolink emits bare URLs instead of
  `<a>`), `<tg-emoji>`, `<blockquote expandable>` (→ a `>`-quoted block, not
  collapsible). The item-5 Unicode prefix styling carries over verbatim (it is
  plain code points), EXCEPT the `<b>`/`<i>` Cyrillic fallback → `*…*`/`_…_`.

## Inbound (webhook, not polling)

- WhatsApp has **no long-poll**. A persistent HTTPS endpoint echoes
  `hub.challenge` on GET verify and 200s POSTs within ~5 s.
- **Cloudflare Tunnel** (free named tunnel) is the recommended always-on path; a
  `cloudflared` process under launchd (macOS) / systemd (Linux). `tg-ctl` gains a
  `whatsapp-webhook` mode (a tiny `Bun.serve`) that the tunnel fronts; it shares
  the singleton lock so it can't double-run.
- The singleton/registration/inject machinery is unchanged — only the *source* of
  inbound events differs (webhook push vs getUpdates pull).

## Q→buttons & /agent buttons under the 24h window

- **Inside the 24h user-initiated window**: free-form interactive reply buttons,
  fully dynamic labels, **max 3 buttons × 20 chars**. Covers the common case.
  `/agent` selection with >3 candidates → fall back to a numbered text list
  ("reply 1/2/3"), since WA caps at 3 buttons.
- **Outside the window**: one pre-approved generic Utility template `"{{1}}"`
  with static `Option 1/2/3` buttons; the dynamic question + option meanings go
  in the body variable. Or drop buttons and parse a numbered reply. A daily
  `/ping` keeps the window open so dynamic buttons work most of the time.

## Config

- `~/.config/tg-cli/.env`: `WA_PHONE_ID`, `WA_TOKEN`, `WA_RECIPIENT`,
  `WA_VERIFY_TOKEN` (webhook), `WA_WEBHOOK_PORT`.
- `control.transport: whatsapp` selects it; `auto` stays Telegram-first.

## Cost & limits

~$0.004/Utility msg (US base), ~$12/mo at heavy use; service messages inside an
open window are free. 80 msg/s default rate (irrelevant at personal scale).
Unverified business = 250 business-initiated conversations/24 h (never hit).

## Build order (when greenlit)

1. Extract the `ChatTransport` interface; move the Telegram code behind it (pure
   refactor, fully test-covered first).
2. `renderForWhatsApp` SendPlan→WA-markup converter (pure, unit-tested).
3. Graph API outbound transport (text/media) behind a fake for tests.
4. `cloudflared` webhook receiver + verify handshake.
5. In-window reply buttons; out-of-window generic template + numbered fallback.
6. One real send/receive smoke against a live WA number (manual, like Telegram).

## Explicit trade-offs to accept

No branded inline emoji; out-of-window buttons need static-label templates +
numbered indirection; an always-on webhook tunnel; per-message cost; one-time
Meta Business setup. If those are unacceptable, **do not add WhatsApp** — Telegram
already covers the outbound-reporting moat with zero infra.
