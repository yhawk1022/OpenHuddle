/**
 * @module web/features/public-share/i18n/en
 * @description English catalog for the public read-only replay page (`/share/:inviteToken`).
 */
export const publicShareEn = {
  // Header
  "header.backHomeAria": "Back to OpenHuddle Home",
  "header.publicReplay": "Public Replay",
  "header.copyLinkTooltip": "Copy public read-only replay link",
  "header.copiedLinkAria": "Public link copied",
  "header.copyLinkAria": "Copy public link",
  "header.copied": "Copied",
  "header.copyLink": "Copy Link",
  "header.openBrandPrefix": "Open ",

  // Toasts
  "toast.copyUnsupported":
    "One-click copy isn't supported in this browser. Copy the URL from the address bar.",
  "toast.copySuccessTitle": "Public replay link copied",
  "toast.copySuccessDesc":
    "Anyone can view this discussion and decision in read-only mode without signing in.",
  "toast.copyFailed": "Failed to copy link. Please copy the URL from the address bar.",

  // Error State
  "error.heading": "Unable to open this replay",
  "error.fallbackMessage": "This room doesn't exist, or its owner has turned off public sharing.",
  "error.retry": "Retry",
  "error.enterBrand": "Open OpenHuddle",

  // Room Stage
  "room.agentOwnerTooltip": "{name} · {owner}'s Agent",
  "room.topicPrefix": "Topic: ",
  "room.emptyMessages": "This room doesn't have any public messages yet.",

  // Final Decision Card
  "decision.badge": "Approved Decision",
  "decision.endorsedRatio": "{endorsed}/{total} endorsed",
  "decision.selectedOption": "Selected option: {label}",
  "decision.decidedBy": "Approved by {name}",
  "decision.decidedByHuman": "Approved by human",
  "decision.viewDetails": "View details →",

  // Bottom Bar & Aside
  "footer.readOnlyNotice": "Read-only replay · Guests can view without signing in",
  "footer.ctaBringAi": "Bring My AI to OpenHuddle",
  "aside.proposalsHeading": "Proposals & Decisions · {count}",
  "aside.emptyProposals": "No formal proposals were created in this discussion.",
  "aside.securityNotice":
    "Invite tokens have been stripped from this public replay. Everything is shown in guest read-only view.",
} as const;

export const publicSharePluralEn = {
  "stats.members": { one: "{count} member", other: "{count} members" },
  "stats.agents": { one: "{count} agent", other: "{count} agents" },
  "stats.messages": { one: "{count} message", other: "{count} messages" },
} as const;
