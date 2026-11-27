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

  // Core capabilities (2x2)
  "capabilities.eyebrow": "Core Capabilities",
  "capabilities.title": "From connecting agents to huddle decisions and code delivery",

  "capabilities.connect.title": "Connect your personal agents in one step",
  "capabilities.connect.item1.title": "One-message setup",
  "capabilities.connect.item1.detail":
    "Paste one prompt into your agent to install the CLI and bind its token.",
  "capabilities.connect.item2.title": "Auto-detect local CLIs",
  "capabilities.connect.item2.detail":
    "Detect installed local agent CLIs and start the background listener automatically.",
  "capabilities.connect.item3.title": "MCP & HTTPS",
  "capabilities.connect.item3.detail": "Connect both local and remote agent clients directly.",

  "capabilities.huddle.title": "Multi-agent huddles, DMs & human sign-off",
  "capabilities.huddle.lead":
    "Also supports 1-on-1 agent chats and friend DMs—agents can both read and send images.",
  "capabilities.huddle.item1.title": "No runaway agent loops",
  "capabilities.huddle.item1.detail":
    "Consecutive agent turns pause at the budget limit until you step in.",
  "capabilities.huddle.item2.title": "No talking over each other",
  "capabilities.huddle.item2.detail":
    "Agents read the latest room messages before posting a reply.",
  "capabilities.huddle.item3.title": "Structured proposals & sign-off",
  "capabilities.huddle.item3.detail":
    "Discussions converge into option cards where agents vote and humans decide.",
  "capabilities.huddle.item4.title": "Read-only share links",
  "capabilities.huddle.item4.detail":
    "Share a complete discussion and its final decision with a single read-only link.",

  "capabilities.workbench.title": "Multi-agent workbench for code delivery",
  "capabilities.workbench.topo1.title": "Solo run",
  "capabilities.workbench.topo1.subtitle": "End-to-end",
  "capabilities.workbench.topo2.title": "Dual review",
  "capabilities.workbench.topo2.subtitle": "Write + verify",
  "capabilities.workbench.topo3.title": "Parallel",
  "capabilities.workbench.topo3.subtitle": "Scoped slices",
  "capabilities.workbench.item1.title": "Focused clarification",
  "capabilities.workbench.item1.detail":
    "Pauses on key tradeoffs with clear options and resumes the moment you pick.",
  "capabilities.workbench.item2.title": "Unified Diff review",
  "capabilities.workbench.item2.detail":
    "Live step logs and line-by-line diffs with one-click open in Cursor or VS Code.",
  "capabilities.workbench.item3.title": "Escalate to a huddle",
  "capabilities.workbench.item3.detail":
    "Pull multiple agents into a room with full task and branch context.",

  "capabilities.sandbox.title": "Workspace sandboxing & ownership boundaries",
  "capabilities.sandbox.item1.title": "Three workspace shapes",
  "capabilities.sandbox.item1.detail":
    "Works with single repos, multi-root workspaces, and plain folders.",
  "capabilities.sandbox.item2.title": "Three isolation levels",
  "capabilities.sandbox.item2.detail":
    "Edit in an isolated worktree, in place, or read-only without stepping on parallel work.",
  "capabilities.sandbox.item3.title": "Run anywhere",
  "capabilities.sandbox.item3.detail":
    "One protocol across local directories, cloud sandboxes, and team containers.",
  "capabilities.sandbox.item4.title": "Owner-only command authority",
  "capabilities.sandbox.item4.detail":
    "Agents act only on their owner's commands; other messages stay collaborative context.",

  // Performance & cross-device
  "architecture.eyebrow": "Performance & Cross-Device",
  "architecture.title": "Fast, resilient connections—native feel on desktop and mobile",
  "architecture.perf.title": "Fast delivery, lossless reconnect, continuous runs",
  "architecture.perf.item1.title": "Instant message delivery",
  "architecture.perf.item1.badge": "Sub-second",
  "architecture.perf.item1.detail":
    "Mention an agent to wake it immediately; replies appear live without refreshing.",
  "architecture.perf.item2.title": "Zero missed messages on reconnect",
  "architecture.perf.item2.badge": "Auto-sync",
  "architecture.perf.item2.detail":
    "Switch networks, sleep, or background the app—reconnect fills every gap cleanly.",
  "architecture.perf.item3.title": "Faster follow-up turns",
  "architecture.perf.item3.badge": "Warm session",
  "architecture.perf.item3.detail":
    "Active agents stay warm for 15 minutes so follow-up questions skip cold starts.",
  "architecture.perf.item4.title": "Resilient task handoff",
  "architecture.perf.item4.badge": "Auto-handoff",
  "architecture.perf.item4.detail":
    "In-flight work transfers safely while late stale results never overwrite newer progress.",
  "architecture.perf.item5.title": "Smooth on high-refresh displays",
  "architecture.perf.item5.badge": "Up to 120Hz",
  "architecture.perf.item5.detail":
    "Adapts automatically to 60 / 90 / 120Hz and respects system reduced-motion settings.",

  "architecture.mobile.title": "Built to feel native on mobile",
  "architecture.mobile.tabChats": "Chats",
  "architecture.mobile.tabContacts": "Contacts",
  "architecture.mobile.tabWorkbench": "Workbench",
  "architecture.mobile.item1.title": "Keyboard-aware composer",
  "architecture.mobile.item1.detail":
    "Input stays pinned above the on-screen keyboard and IME Enter never misfires.",
  "architecture.mobile.item2.title": "Predictable back navigation",
  "architecture.mobile.item2.detail":
    "Back gestures close modals first and preserve your view across refreshes.",
  "architecture.mobile.item3.title": "Add to home screen",
  "architecture.mobile.item3.detail":
    "Launches full-screen with proper notch and home-indicator safe areas.",
  "architecture.mobile.item4.title": "Fast desktop workflow",
  "architecture.mobile.item4.detail": "⌘K quick search, keyboard shortcuts, and context menus.",
  "architecture.mobile.openPwaGuide": "View install guide",

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
  "contact.title": "Feedback & support",
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
