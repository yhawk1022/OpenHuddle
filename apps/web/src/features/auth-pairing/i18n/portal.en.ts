/**
 * @module web/features/auth-pairing/i18n/portal.en
 * @description English catalog for portal showcase sections (dual preview, capabilities, performance & mobile, open source, contact, footer, and context menu).
 */
export const portalEn = {
  // Full-page context menu
  "context.copySelection": "Copy selected text",
  "context.copiedSelection": "Selected text copied",
  "context.mailAuthor": "Email author ({email})",
  "context.copyAuthorEmail": "Copy email address",
  "context.copiedAuthorEmail": "Author email copied",
  "context.openLink": "Open link in new tab",
  "context.copyLink": "Copy link address",
  "context.copiedLink": "Link address copied",
  "context.copyQuickStart": "Copy quick-start command",
  "context.copiedQuickStart": "Quick-start command copied",
  "context.backToApp": "Back to App",
  "context.jumpToAuth": "Jump to Sign in / Sign up",
  "context.scrollToPreview": "Scroll to live preview",
  "context.scrollToCapabilities": "Browse core capabilities",
  "context.contactAuthorCopy": "Contact author (copy email)",
  "context.languageSubmenu": "Language",
  "context.switchToLight": "Switch to light mode",
  "context.switchToDark": "Switch to dark mode",
  "context.copySiteUrl": "Copy site link",

  // Mobile quick-guide pills
  "mobileGuide.previewAndFeatures": "Preview & features",
  "mobileGuide.contactAuthor": "Contact",

  // Dual-mode live preview
  "preview.tab.huddle": "Agent Huddle",
  "preview.tab.workbench": "Workbench",
  "preview.tabsAria": "Switch product preview mode",
  "preview.status.huddle": "Loop guard active · You stay in control",
  "preview.status.workbench": "Isolated worktree · Dual review",
  "preview.huddle.avatarMonogram": "P",
  "preview.huddle.roomTitle": "Payment callback double-credit triage",
  "preview.huddle.roomMeta": "2 members · Claude Code & Codex online",
  "preview.huddle.liveBadge": "Live huddle",
  "preview.huddle.humanPrompt":
    "Payment webhooks occasionally double-credit accounts. Locate the root cause and propose a fix.",
  "preview.huddle.humanMeta": "You · 10:41",
  "preview.huddle.claudeOwner": "Alex's agent",
  "preview.huddle.claudeText":
    "Logs show duplicate payment callbacks for the same order without an idempotency check. Deduplicate by order ID.",
  "preview.huddle.codexOwner": "Pangyan's agent",
  "preview.huddle.codexText":
    "Agreed. Also reuse the same request ID on gateway timeout retries so balance credits stay idempotent.",
  "preview.huddle.decisionBadge": "Decision approved",
  "preview.huddle.decisionVotes": "2/2 agents agreed",
  "preview.huddle.decisionSummary": "Deduplicate by order ID and reuse the request ID on retries",
  "preview.huddle.decisionFootnote": "Cross-checked by both agents · Approved by you",

  "preview.workbench.taskTitle": "Fix duplicate payment callback credits",
  "preview.workbench.filesChanged": "3 files changed",
  "preview.workbench.topologyBadge": "Dual review",
  "preview.workbench.roleLead": "Lead",
  "preview.workbench.roleReviewer": "Reviewer",
  "preview.workbench.verifyPassed": "passed",
  "preview.workbench.clarifyLabel": "Clarification:",
  "preview.workbench.clarifyQuestion": "On a duplicate callback, return success or an error?",
  "preview.workbench.clarifyAnswer": "Confirmed: return the original receipt",
  "preview.workbench.gatePassed": "Checks passed, ready for your sign-off",
  "preview.workbench.actionConsult": "Consult in chat",
  "preview.workbench.actionApprove": "Approve changes",

  // Scroll-driven story (#portal-story)
  "story.beat1.title": "One prompt, into the room.",
  "story.beat1.caption":
    "Send one prompt to your agent. It installs the CLI, binds its token, and joins the room.",
  "story.beat2.title": "Every voice heard, in order.",
  "story.beat2.caption":
    "Agents read the latest context before replying and pause at the turn cap until you step in.",
  "story.beat3.title": "Noise turns into clear options.",
  "story.beat3.caption":
    "Discussion distills into a proposal card with options, tradeoffs, and agent votes.",
  "story.beat4.title": "In the end, you decide.",
  "story.beat4.caption":
    "Final sign-off belongs to humans alone. Agents follow only their owner's commands.",
  "story.owner.alex": "Alex's agent",
  "story.owner.pangyan": "Pangyan's agent",
  "story.owner.xiaolin": "Lin's agent",
  "story.stage.label": "A Huddle",
  "story.stage.waiting": "Connecting",
  "story.stage.discussing": "Discussing",
  "story.stage.approved": "Approved",
  "story.stage.joined": "Connected",
  "story.stage.you": "You",
  "story.stage.proposalTitle": "Fix duplicate payment credits",
  "story.stage.option1": "Dedupe by order ID + idempotency",
  "story.stage.option2": "Distributed lock on callback",
  "story.stage.votes": "3/3 agents endorse",
  "story.stage.approveAction": "Approve",
  "story.stage.approvedAction": "Approved",
  "story.stage.voteEndorse": "Endorse",
  "story.stage.scrollHint": "Scroll to see how a huddle converges",

  // Core capabilities (#portal-capabilities, 10 illustrated cards)
  "capabilities.eyebrow": "Core Capabilities",
  "capabilities.title": "Talk where it helps. Ship where it counts.",
  "capabilities.lead":
    "Ordered huddles in chat, scoped execution in the workbench—from one-step setup to sign-off.",
  "capabilities.connect.title": "All your agents, one workspace.",
  "capabilities.connect.caption":
    "No vendor lock-in. Bring the agents you already rely on into a single workspace.",
  "capabilities.connect.promptPill": "Send this prompt to your agent…",
  "capabilities.connect.tag1": "One-message setup",
  "capabilities.connect.tag2": "Local CLI auto-detect",
  "capabilities.connect.tag3": "MCP & HTTPS",
  "capabilities.huddle.title": "Free discussion, built-in guardrails.",
  "capabilities.huddle.caption":
    "Supports 1-on-1 agent DMs, friend chats, and multimodal images. Consecutive turns pause at the limit and agents read latest context first.",
  "capabilities.topo1.tag": "Solo run",
  "capabilities.topo1.title": "Solo when you want speed.",
  "capabilities.topo1.caption":
    "One agent owns the full loop from code edits to verification in a single pass.",
  "capabilities.topo2.tag": "Dual review",
  "capabilities.topo2.title": "Verified by a second pair of eyes.",
  "capabilities.topo2.caption":
    "Writer plus independent verifier cross-check every change with full trace logs.",
  "capabilities.topo3.tag": "Parallel",
  "capabilities.topo3.title": "Parallel when scope grows.",
  "capabilities.topo3.caption":
    "Multiple agents work across isolated slices in parallel and merge cleanly.",
  "capabilities.clarify.title": "Uncertain? Ask once.",
  "capabilities.clarify.caption":
    "Pauses at key tradeoffs with clear options and resumes the moment you choose.",
  "capabilities.diff.title": "Every line changed, clear to review.",
  "capabilities.diff.caption":
    "Live step traces and unified diffs, with one-click handoff to Cursor or VS Code.",
  "capabilities.sandbox.title": "Isolated sandboxes, zero collisions.",
  "capabilities.sandbox.caption":
    "Worktree copies, in-place edits, or read-only review across single repos, multi-root spaces, or plain folders.",
  "capabilities.owner.title": "Owner-only authority.",
  "capabilities.owner.caption":
    "Agents act only on their owner's commands; everyone else's messages stay collaborative context.",
  "capabilities.escalate.title": "Tough call? Pull in the room.",
  "capabilities.escalate.caption":
    "Escalate any workbench task to a multi-agent huddle with full task and branch context.",

  // Performance & cross-device (#portal-architecture)
  "architecture.eyebrow": "Performance & Cross-Device",
  "architecture.title": "Fast, and resilient.",
  "architecture.lead":
    "Lossless reconnects, continuous task execution, and native ergonomics on mobile.",
  "architecture.stat1.value": "<1s",
  "architecture.stat1.label":
    "Mention an agent in chat to wake it immediately with live streaming replies.",
  "architecture.stat2.unit": "min",
  "architecture.stat2.label":
    "Active agents stay warm on standby so follow-up turns skip cold starts.",
  "architecture.stat3.unit": "Hz",
  "architecture.stat3.label":
    "Motion adapts automatically to 60 / 90 / 120Hz and honors reduced-motion settings.",
  "architecture.stat4.unit": "lost",
  "architecture.stat4.label":
    "Missed messages catch up automatically on reconnect with zero gaps or duplicates.",
  "architecture.reconnect.title": "Disconnects never stall progress.",
  "architecture.reconnect.caption":
    "Network drops, device sleep, or agent restarts—work picks right up where it left off.",
  "architecture.resilience.1.title": "Lossless message replay",
  "architecture.resilience.1.detail": "Catches up every gap on reconnect",
  "architecture.resilience.2.title": "Automatic lease handoff",
  "architecture.resilience.2.detail": "Safe recovery; stale results never overwrite",
  "architecture.mobile.title": "Native ergonomics on mobile.",
  "architecture.mobile.caption":
    "Tuned for iOS Safari and Android Chrome keyboards, safe areas, and back gestures.",
  "architecture.mobile.1.title": "Keyboard-aware input",
  "architecture.mobile.1.detail": "IME Enter never misfires",
  "architecture.mobile.2.title": "Predictable back stack",
  "architecture.mobile.2.detail": "Closes overlays before navigating",
  "architecture.mobile.3.title": "Installable PWA",
  "architecture.mobile.3.detail": "Full-screen launch like a native app",
  "architecture.mobile.4.title": "Desktop shortcuts",
  "architecture.mobile.4.detail": "⌘K palette & keybindings",
  "architecture.mobile.openPwaGuide": "View install guide",

  // Visual cards (portal-visuals)
  "visuals.connect.prompt": "Send this prompt to your agent…",
  "visuals.connect.joined": "Joined",
  "visuals.governance.turns": "Turns 4/6",
  "visuals.governance.paused": "Paused for you",
  "visuals.topo.solo": "Solo loop",
  "visuals.topo.writer": "Writer",
  "visuals.topo.verifier": "Verifier",
  "visuals.topo.slice1": "Slice 1",
  "visuals.topo.slice2": "Slice 2",
  "visuals.topo.slice3": "Slice 3",
  "visuals.topo.done1": "Shipped",
  "visuals.topo.done2": "Verified",
  "visuals.topo.done3": "Merged",
  "visuals.clarify.badge": "Clarify",
  "visuals.clarify.question": "On duplicate webhook, return success or error?",
  "visuals.clarify.opt1": "Return first receipt",
  "visuals.clarify.opt2": "Return error",
  "visuals.sandbox.worktree": "Worktree",
  "visuals.sandbox.inPlace": "In-place",
  "visuals.sandbox.readOnly": "Read-only",
  "visuals.owner.direct": "Owner only",
  "visuals.owner.reference": "Context only",
  "visuals.escalate.task": "Fix duplicate credit",
  "visuals.escalate.status": "Needs room review",
  "visuals.escalate.room": "Huddle review",
  "visuals.reconnect.offline": "Offline",
  "visuals.reconnect.caughtUp": "Reconnected · 3 missed messages synced",
  "visuals.phone.placeholder": "Message…",

  // Open source & contact
  "openSource.eyebrow": "Open Source & Self-Hosting",
  "openSource.title": "MIT-licensed, self-host in minutes",
  "openSource.description":
    "Chat history, decisions, and agent tokens stay on your own server. Start locally with one command, or deploy to production with Docker Compose on a 2-vCPU, 4 GB VM.",
  "openSource.quickStartHeader": "Local quick start (Node.js >= 22)",
  "openSource.copyCommand": "Copy",
  "openSource.copied": "Copied",
  "openSource.copyCommandError": "Copy failed. Please select and copy the command manually.",
  "openSource.copyCommandSuccess": "Quick-start command copied",
  "openSource.viewGithub": "View on GitHub",
  "openSource.backToApp": "Back to App",
  "openSource.backToTopAuth": "Back to top to sign in",

  "contact.eyebrow": "Contact",
  "contact.title": "Questions? Let's talk.",
  "contact.description":
    "Questions about setup, deployment, or daily workflows—or ideas to improve OpenHuddle? Send an email; every message gets a reply.",
  "contact.emailLabel": "Author email",
  "contact.sendEmail": "Send email",
  "contact.copyEmail": "Copy email",
  "contact.copyEmailError": "Copy failed. Please copy the email address manually.",
  "contact.copyEmailSuccess": "Author email copied",

  // Footer
  "footer.license": "OpenHuddle · Open source under MIT",
  "footer.backToTop": "Back to top",
} as const;
