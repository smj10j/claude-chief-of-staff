/**
 * Component primitives — PRD-115 §7.5.
 *
 * Six opinionated wrappers that the redesigned surfaces consume.
 * Not a full component library; the bootstrap that lets per-surface
 * design (Home, Work, People, Person Profile, Meetings, Projects)
 * land without each surface re-implementing the same DOM patterns.
 *
 * Each primitive uses semantic tokens only — themes (graphite, paper, …)
 * bind without changes here.
 */

export { SurfaceHero } from "./SurfaceHero";
export type { SurfaceHeroProps } from "./SurfaceHero";

export { SectionHeader } from "./SectionHeader";
export type { SectionHeaderProps } from "./SectionHeader";

export { TimelineStrip } from "./TimelineStrip";
export type {
  TimelineStripProps,
  TimelineEvent,
  TimelineEventTone,
} from "./TimelineStrip";

export { PersonCard } from "./PersonCard";
export type { PersonCardProps } from "./PersonCard";

export { SnippetCard } from "./SnippetCard";
export type { SnippetCardProps, SnippetFollowUp } from "./SnippetCard";

export { TimeBucket } from "./TimeBucket";
export type { TimeBucketProps, TimeBucketTone } from "./TimeBucket";
