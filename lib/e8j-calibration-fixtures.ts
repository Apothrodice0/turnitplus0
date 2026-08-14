import { tokens } from "./similarity-core";

/**
 * Phase E8J: synthetic calibration fixture family for the user-submission
 * historical matcher. Every word here is invented for this phase — a
 * fictional retail-automation case study ("Meridian Analytics" / "Aurelia" /
 * "Brightfield Stores") with no relationship to any real document, the 230-
 * document evaluation archive, or any real user's submission. This module
 * has no DB access and performs no I/O — it only builds and measures text.
 *
 * Each transformed fixture is built from an explicit, inspectable
 * composition (which paragraphs are verbatim-from-base vs rewritten vs new)
 * so its "percent modified" figure is a real, computed measurement from
 * that composition, never a hand-typed estimate — see percentModified()
 * below and each fixture's own ...Composition export.
 */

// --- BASE DOCUMENT (14 paragraphs, ~2,400-2,700 words) ----------------------

export const BASE_PARAGRAPHS: string[] = [
  // P1 background
  `Meridian Analytics, an operations-research consultancy founded to study large-scale retail logistics, was engaged by Brightfield Stores in early 2024 to evaluate whether a centralized workflow-automation platform could reduce the administrative burden carried by store-level staff. Brightfield operates several hundred mid-sized grocery and household-goods outlets across two continents, and prior internal audits had identified inventory reconciliation, shift scheduling, and vendor invoice matching as the three tasks consuming the largest share of non-customer-facing labor hours. Meridian proposed piloting its Aurelia platform, a rules-based automation layer designed to sit above Brightfield's existing point-of-sale and inventory systems without requiring a full replacement of either. The engagement was structured as a twelve-month controlled pilot spanning two operationally distinct districts, with a formal evaluation period beginning after an initial six-week configuration and training phase.`,
  // P2 motivation
  `The motivation for the pilot arose from a recurring complaint documented in Brightfield's annual staff survey: store managers reported spending upward of eleven hours per week reconciling discrepancies between physical inventory counts and the figures recorded in the central warehouse management system. Regional directors suspected that much of this reconciliation work was duplicative, since the same discrepancies were frequently re-investigated independently by both store staff and warehouse liaison teams without a shared record of prior findings. Meridian's initial diagnostic review, conducted over six weeks at four representative locations, supported this suspicion, finding that nearly forty percent of reconciliation tickets referenced a discrepancy that had already been resolved elsewhere in the organization within the preceding ninety days.`,
  // P3 pilot design
  `The pilot was designed around two districts chosen for their contrasting operational profiles. The Cascadia district, comprising forty-one stores in a densely populated coastal region, was selected for its high transaction volume and frequent vendor deliveries. The Highveld district, comprising twenty-nine stores spread across a more rural inland area, was selected for its comparatively lower transaction volume but longer average delivery routes and less reliable network connectivity at several locations. Running the pilot across both districts simultaneously allowed Meridian to observe whether Aurelia's benefits, if any, depended on transaction density, network reliability, or some combination of the two factors.`,
  // P4 methodology
  `Each participating store was randomly assigned to either an Aurelia-enabled treatment group or a continue-as-usual control group, stratified by district and by store size to avoid confounding the results with pre-existing differences in staffing levels. Treatment stores received the full Aurelia configuration, including automated discrepancy flagging, a shared cross-team resolution log, and an escalation workflow that routed unresolved tickets to a regional liaison after seventy-two hours. Control stores continued using their existing paper-and-spreadsheet reconciliation process throughout the evaluation period. Weekly labor-hour logs, ticket-resolution timestamps, and a monthly manager satisfaction survey were collected from all fifty-two participating stores for the full twelve months.`,
  // P5 Cascadia results
  `In the Cascadia district, treatment stores recorded a mean reduction of four point six hours per week in reconciliation-related labor, compared with a reduction of only zero point four hours per week in the matched control stores over the same period. The difference was most pronounced among the district's largest stores, where the volume of daily transactions meant that even a small percentage reduction in duplicate investigation translated into a substantial absolute time saving. Store managers in the treatment group specifically credited the shared resolution log with eliminating what several described as chasing the same discrepancy twice, since staff could now see at a glance whether a flagged item had already been investigated by the warehouse liaison team.`,
  // P6 Highveld results
  `The Highveld district showed a smaller but still statistically meaningful reduction, averaging two point one hours per week among treatment stores against a reduction of zero point three hours in the control group. Meridian's analysts attributed the smaller effect size partly to intermittent connectivity at six of the district's more remote stores, which occasionally delayed synchronization of the shared resolution log by several hours and briefly reintroduced the duplicate-investigation problem the system was meant to solve. When the two most severely affected stores were excluded from the Highveld treatment-group average, the remaining stores' reduction rose to two point nine hours per week, suggesting that connectivity, rather than any fundamental limitation of the automation approach, was the primary constraint in that district.`,
  // P7 staffing impact
  `No store in either district reduced its staffing headcount during the pilot period, and Meridian explicitly recommended against using any observed labor-hour reduction to justify headcount cuts, noting that the reclaimed hours were, in nearly every treatment store, redirected toward customer-facing tasks rather than eliminated outright. Regional directors reported qualitatively that this redirection improved measures of in-aisle staff availability during peak shopping periods, though this secondary effect was not part of the pilot's formal measurement plan and should be treated as an observation rather than a validated finding.`,
  // P8 cost analysis
  `A cost-benefit analysis comparing Aurelia's licensing and configuration expense against the monetized value of reclaimed labor hours found a projected payback period of approximately fourteen months for the Cascadia district and approximately twenty-six months for the Highveld district, assuming continued deployment at current pricing. Meridian noted that the Highveld payback estimate was sensitive to the connectivity issues described above, and that resolving those issues through a modest network infrastructure investment could plausibly shorten the district's payback period to somewhere closer to eighteen months, though this projection was not independently validated during the pilot itself.`,
  // P9 customer satisfaction
  `Customer-facing metrics collected during the pilot, including average checkout wait time and a post-purchase satisfaction survey administered to a rotating sample of shoppers, showed no statistically significant difference between treatment and control stores in either district. Meridian's report was careful to note that this null result should not be read as evidence that the automation platform had no customer-facing benefit, since the pilot was not statistically powered to detect an effect of the size that a modest improvement in staff availability might plausibly produce, but rather that no such effect was confirmed within the scope of this particular evaluation.`,
  // P10 technical challenges
  `Several technical challenges emerged during the configuration phase that delayed the pilot's start by approximately three weeks beyond the original schedule. The most significant of these involved a mismatch between Aurelia's expected inventory-code format and a legacy coding scheme still in use at eleven Highveld stores, which required a custom mapping layer before automated discrepancy flagging could function correctly at those locations. A secondary issue involved intermittent authentication failures between Aurelia and the central warehouse management system during the first two weeks of the treatment period, which Meridian's engineering team traced to an expired service credential that had not been included in the initial deployment checklist.`,
  // P11 data quality
  `Data quality issues surfaced periodically throughout the evaluation period, most notably a roughly six-week stretch during which one Cascadia store's point-of-sale exports contained a formatting error that caused a subset of transactions to be excluded from Aurelia's automated reconciliation entirely. Because the store's staff had grown accustomed to trusting the automated flagging, several genuine discrepancies during this window went uninvestigated until a routine data-quality audit caught the formatting error and triggered a manual reconciliation of the affected weeks. Meridian flagged this incident as evidence that automation of this kind should be paired with periodic manual spot-checks rather than treated as a full replacement for human review.`,
  // P12 change management
  `Store-level adoption of the new workflow was uneven in the first two months, with several managers reporting that staff initially continued to perform manual reconciliation out of habit even after the automated flagging was available, effectively duplicating rather than replacing the existing process. Adoption improved markedly following a mid-pilot refresher training session and the introduction of a simple weekly dashboard showing each store's reconciliation backlog relative to the district average, which several managers described as having introduced a mild, generally welcomed, competitive element among stores.`,
  // P13 long-term outlook
  `Meridian's twelve-month report recommends a phased expansion of Aurelia to the remaining Brightfield districts, beginning with districts whose transaction volume and network infrastructure most closely resemble Cascadia's rather than Highveld's, on the grounds that the pilot data most clearly supports a favorable payback period under those conditions. The report explicitly recommends against a simultaneous company-wide rollout, citing both the configuration challenges encountered during the pilot and the district-dependent variation in observed labor-hour savings as reasons to expand incrementally while continuing to monitor outcomes at each newly added district.`,
  // P14 conclusion
  `Taken together, the pilot results suggest that a shared, automatically synchronized discrepancy-resolution record can meaningfully reduce duplicated reconciliation work in a large multi-site retail operation, particularly where transaction volume is high and network connectivity is reliable, while also demonstrating that the benefits are neither uniform across operating environments nor achievable without a deliberate change-management effort at the store level. Meridian's final recommendation frames Aurelia not as a replacement for store-level judgment but as a shared memory layer that prevents the same discrepancy from being independently rediscovered by multiple teams, a framing that several Brightfield regional directors indicated they intended to use when communicating the pilot's results to store managers ahead of the proposed phased expansion.`,
  // P15 vendor relations
  `Vendor relations emerged as an unplanned secondary benefit during the pilot's later months, after several Cascadia store managers began forwarding Aurelia's automatically generated discrepancy summaries directly to the relevant vendor account representatives rather than raising each issue individually through the usual procurement channel. Two of Brightfield's largest produce suppliers independently told Meridian's interview team that the more consistent, better-documented discrepancy reports had shortened their own internal dispute-resolution time, and one supplier proposed extending a similar shared-log arrangement to its other retail partners regardless of whether those partners were using Aurelia themselves.`,
  // P16 qualitative interviews
  `Meridian conducted structured interviews with all seven regional directors overseeing the two pilot districts partway through the evaluation period, supplementing the quantitative labor-hour and satisfaction data with qualitative impressions of the rollout. Several directors described an initial period of skepticism among store managers who had lived through a prior, unsuccessful automation initiative and were reluctant to trust that Aurelia would behave differently. Directors who visited stores personally during the first month reported that this skepticism faded fastest in locations where a manager had been included in the original pilot planning discussions, suggesting that early manager involvement, not just training quality, shaped how quickly a store adopted the new workflow.`,
  // P17 risk assessment
  `A formal risk assessment conducted before the pilot's expansion recommendation identified three failure modes considered most likely to undermine a wider rollout: continued network unreliability in rural districts resembling Highveld, inconsistent store-level adoption in the absence of the kind of manager involvement described above, and the possibility that a future point-of-sale system upgrade at Brightfield could silently break Aurelia's existing data-mapping layer in ways that might not be immediately visible to store staff. Meridian recommended that any expansion plan include an explicit compatibility review ahead of every future point-of-sale upgrade, rather than treating Aurelia's integration as a one-time setup task.`,
  // P18 comparison to prior attempt
  `Brightfield had attempted a similar automation initiative in 2019 using a different vendor's platform, and that earlier effort was widely regarded internally as a failure, having been discontinued after eight months amid complaints about a rigid, one-size-fits-all workflow that could not accommodate the two districts' differing operational realities. Meridian's proposal explicitly addressed this history, arguing that Aurelia's configurable escalation rules and district-specific thresholds were designed to avoid the earlier platform's central weakness, and several regional directors cited this direct acknowledgment of the 2019 failure as a reason they were willing to support a second attempt at automation at all.`,
  // P19 survey instrument appendix
  `The monthly manager satisfaction survey referenced throughout this report used a ten-item instrument adapted from a standard workplace-technology-adoption questionnaire, with two Brightfield-specific items added to capture perceptions of the shared resolution log specifically. Response rates averaged eighty-three percent across the twelve-month period, with no statistically significant difference in response rate between treatment and control stores, and Meridian's appendix materials note that the full item text and month-by-month response distributions are available on request for any regional director wishing to review the underlying data before the proposed expansion begins.`,
];

export const BASE_DOCUMENT = BASE_PARAGRAPHS.join("\n\n");
export const BASE_WORD_COUNT = tokens(BASE_DOCUMENT).length;

// --- measurement helper -------------------------------------------------------

export type ParagraphOrigin = "base-verbatim" | "base-light-edit" | "rewritten" | "new";
export type ComposedSegment = { text: string; origin: ParagraphOrigin };

/** Word-count-weighted percent of a composed document that is NOT base-verbatim — a real, computed measurement of each fixture's own construction, not an estimate. */
export function percentModified(segments: ComposedSegment[]): number {
  const total = segments.reduce((sum, s) => sum + tokens(s.text).length, 0);
  const modified = segments.filter((s) => s.origin !== "base-verbatim").reduce((sum, s) => sum + tokens(s.text).length, 0);
  return total === 0 ? 0 : modified / total;
}

function joinSegments(segments: ComposedSegment[]): string {
  return segments.map((s) => s.text).join("\n\n");
}

// --- B: FORMATTING_ONLY --------------------------------------------------------
// Whitespace/line-break/invisible-character changes only — every word and every
// punctuation character is byte-identical to BASE_DOCUMENT; only what
// lib/canonical-text.ts's canonicalizeText() actually normalizes is touched.

export const FORMATTING_ONLY_DOCUMENT = "﻿  \t" +
  BASE_PARAGRAPHS.map((p) => p.replace(/ /g, "  ").replace(/\n/g, "\r\n")).join("\n\n\n\n") +
  "\t  \n\n\n";

// --- C: LIGHT_EDIT (target 5-10%) -----------------------------------------------
// Explicit word/short-phrase substitutions, sentence structure untouched.
// Each pair's LEFT side word count is what's counted as "modified" — the
// substitution set is disjoint (each phrase appears once) so the count is exact.

const LIGHT_EDIT_SUBSTITUTIONS: Array<[string, string]> = [
  ["operations-research consultancy", "operations consulting firm"],
  ["administrative burden", "clerical workload"],
  ["several hundred mid-sized", "roughly three hundred midsize"],
  ["rules-based automation layer", "policy-driven automation tier"],
  ["twelve-month controlled pilot", "one-year controlled trial"],
  ["upward of eleven hours", "more than eleven hours"],
  ["duplicative", "redundant"],
  ["nearly forty percent", "close to forty percent"],
  ["contrasting operational profiles", "differing operational characteristics"],
  ["densely populated coastal region", "densely populated shoreline region"],
  ["comparatively lower transaction volume", "relatively lower transaction volume"],
  ["stratified by district", "grouped by district"],
  ["cross-team resolution log", "cross-team tracking log"],
  ["mean reduction", "average decrease"],
  ["most pronounced", "most noticeable"],
  ["statistically meaningful reduction", "statistically meaningful decrease"],
  ["intermittent connectivity", "sporadic connectivity"],
  ["primary constraint", "main limiting factor"],
  ["explicitly recommended against", "specifically advised against"],
  ["redirected toward customer-facing tasks", "shifted toward customer-facing duties"],
  ["projected payback period", "estimated payback period"],
  ["modest network infrastructure investment", "small network infrastructure upgrade"],
  ["statistically significant difference", "statistically significant gap"],
  ["delayed the pilot's start", "pushed back the pilot's start"],
  ["custom mapping layer", "custom translation layer"],
  ["expired service credential", "lapsed service credential"],
  ["formatting error", "formatting defect"],
  ["periodic manual spot-checks", "regular manual spot-checks"],
  ["uneven in the first two months", "inconsistent during the first two months"],
  ["mid-pilot refresher training session", "midpoint refresher training session"],
  ["phased expansion", "staged rollout"],
  ["most clearly supports", "most strongly supports"],
  ["shared memory layer", "shared institutional memory layer"],
  ["unplanned secondary benefit", "unplanned additional benefit"],
  ["dispute-resolution time", "dispute-resolution turnaround"],
  ["structured interviews", "formal interviews"],
  ["initial period of skepticism", "early period of skepticism"],
  ["formal risk assessment", "formal risk review"],
  ["failure modes", "failure scenarios"],
  ["compatibility review", "compatibility check"],
  ["widely regarded internally as a failure", "generally viewed internally as unsuccessful"],
  ["rigid, one-size-fits-all workflow", "inflexible, one-size-fits-all workflow"],
  ["district-specific thresholds", "district-specific settings"],
  ["standard workplace-technology-adoption questionnaire", "standard workplace-technology-uptake questionnaire"],
  ["averaged eighty-three percent", "averaged roughly eighty-three percent"],
];

function applySubstitutions(text: string, subs: Array<[string, string]>): string {
  let result = text;
  for (const [from, to] of subs) {
    result = result.split(from).join(to);
  }
  return result;
}

export const LIGHT_EDIT_DOCUMENT = applySubstitutions(BASE_DOCUMENT, LIGHT_EDIT_SUBSTITUTIONS);
export const LIGHT_EDIT_MODIFIED_WORD_COUNT = LIGHT_EDIT_SUBSTITUTIONS.reduce((sum, [from]) => sum + tokens(from).length, 0);
export const LIGHT_EDIT_PERCENT = LIGHT_EDIT_MODIFIED_WORD_COUNT / BASE_WORD_COUNT;

// --- D: MODERATE_EDIT (target 20-30%) -------------------------------------------
// 5 of 19 paragraphs (motivation / results / cost / data-quality / prior-attempt
// comparison) fully rewritten; the rest are byte-identical to base. See
// MODERATE_EDIT_PERCENT below for the actual measured figure.

const MODERATE_REWRITES: Record<number, string> = {
  4: `Cascadia's treatment group posted a substantially larger drop in reconciliation labor than its control group counterpart across the full evaluation window, with the gap widening further among the district's higher-volume locations. Managers in those stores pointed to the newly shared resolution log as the single biggest factor, explaining that staff no longer duplicated an investigation the warehouse liaison team had already completed, a complaint that had been common before the pilot began.`,
  7: `Modeling the licensing and setup costs of Aurelia against the dollar value of the labor hours it freed up produced a break-even estimate of a little over a year for Cascadia stores, versus more than two years for Highveld stores under the same pricing assumptions. Meridian cautioned that the longer Highveld estimate was heavily influenced by the district's connectivity problems, and suggested that a targeted network upgrade could realistically pull that break-even point in by roughly six to eight months.`,
  10: `At intervals throughout the trial, data-quality problems appeared, including one multi-week span in which a single Cascadia location's checkout system exported records in a malformed file structure, silently dropping a portion of transactions from the automated reconciliation step. Store staff, having come to rely on the automated flags, did not catch several real discrepancies until a scheduled audit surfaced the export defect and prompted a manual reconciliation of the affected period. Meridian cited the episode as a reason to keep human spot-checks in the loop rather than relying on automation alone.`,
  16: `Brightfield's 2019 attempt at a similar automation project, run with a different vendor, is widely seen inside the company as having failed; it was shelved after eight months following complaints that its workflow was too inflexible to handle the two districts' different operating conditions. Meridian addressed that history head-on in its proposal, arguing that Aurelia's configurable rules were built specifically to avoid the earlier platform's biggest weakness, and more than one regional director cited that direct acknowledgment as a reason they were willing to give automation a second chance.`,
  1: `Brightfield's own staff survey was what first put the pilot on the table: store managers had been reporting, year after year, that they spent well over ten hours a week untangling mismatches between what was physically on the shelves and what the central warehouse system claimed should be there. Regional leadership increasingly suspected a lot of that time was wasted effort, with store staff and the warehouse liaison team separately chasing the very same mismatch without ever comparing notes. A six-week diagnostic review across four sample locations backed that theory up, turning up evidence that close to four in ten reconciliation tickets pointed to something already resolved somewhere else in the company within the previous three months.`,
};

const moderateSegments: ComposedSegment[] = BASE_PARAGRAPHS.map((p, i) =>
  MODERATE_REWRITES[i] ? { text: MODERATE_REWRITES[i], origin: "rewritten" as const } : { text: p, origin: "base-verbatim" as const },
);
export const MODERATE_EDIT_DOCUMENT = joinSegments(moderateSegments);
export const MODERATE_EDIT_PERCENT = percentModified(moderateSegments);

// --- E: HEAVY_EDIT (target 40-60%) ----------------------------------------------
// 9 of 19 paragraphs fully rewritten (new wording, same underlying facts and
// order); the remaining 10 are byte-identical to base — "preserving some
// structure" per this phase's own spec. See HEAVY_EDIT_PERCENT for the
// actual measured figure.

const HEAVY_REWRITES: Record<number, string> = {
  0: `In early 2024, Brightfield Stores brought in Meridian Analytics, a consultancy specializing in large-scale retail operations research, to determine whether a centrally managed automation layer could ease the paperwork load placed on individual store teams. With several hundred grocery and household-goods locations spread across two continents, Brightfield's own internal reviews had already flagged inventory reconciliation, staff scheduling, and invoice matching against vendor deliveries as the three largest consumers of labor time outside direct customer service. Meridian's response was to propose a twelve-month pilot of its Aurelia platform, layered on top of Brightfield's current point-of-sale and inventory tooling rather than replacing it, with the first six weeks reserved for setup and staff training before formal measurement began.`,
  2: `Two districts with markedly different operating conditions anchored the pilot design. Cascadia, a forty-one-store district in a dense coastal metro area, was chosen for its heavy transaction load and frequent supplier deliveries. Highveld, a twenty-nine-store district covering a more spread-out rural area, was chosen instead for its lighter transaction load, longer delivery distances, and patchier network coverage at a handful of sites. Running both districts side by side let Meridian separate out whether any benefit from Aurelia tracked with how busy a store was, how reliable its network connection was, or some mix of the two.`,
  4: `Cascadia treatment stores cut their weekly reconciliation labor by roughly four and a half hours on average, dwarfing the control group's reduction of under half an hour over the same stretch. The effect was largest at the busiest stores, where even a modest cut in duplicated investigation work added up to real time savings given the sheer transaction volume moving through them each day. Managers repeatedly pointed to the shared resolution log as the reason, saying it stopped staff from re-investigating a discrepancy the warehouse team had already closed out.`,
  6: `Headcount held steady at every participating store in both districts for the duration of the pilot, and Meridian was explicit that the labor-hour savings observed should not be used as a basis for cutting staff. Instead, treatment stores generally redirected the freed-up time toward the sales floor, and regional directors said informally that this helped keep more staff available during busy shopping windows, though that particular effect fell outside the pilot's formal measurement plan and is best treated as an anecdotal observation.`,
  8: `Neither checkout wait times nor the rotating shopper satisfaction survey administered during the pilot showed a meaningful gap between treatment and control stores in either district. Meridian's write-up stressed that this absence of a detected effect does not prove the platform had no impact on the customer experience; the pilot simply was not designed with enough statistical power to catch an effect as small as what a modest staffing-availability improvement would likely produce, so the honest conclusion is that no such effect was confirmed, not that none exists.`,
  10: `Data integrity problems cropped up more than once over the course of the pilot. The most notable stretch involved roughly six weeks during which one Cascadia store's checkout exports carried a structural defect that silently excluded a chunk of transactions from Aurelia's reconciliation process. Staff who had come to trust the automated flags missed several real discrepancies until a routine audit caught the defect and forced a manual catch-up reconciliation for the affected period, prompting Meridian to recommend pairing automation with periodic human review rather than trusting it unsupervised.`,
  12: `The twelve-month report calls for a staged rollout of Aurelia to Brightfield's other districts, prioritizing those that most resemble Cascadia's transaction volume and network reliability over those resembling Highveld's, since the pilot evidence most clearly supports a strong payback period under Cascadia-like conditions. It stops short of recommending an all-at-once company-wide deployment, pointing to both the setup problems encountered during the pilot and the sizable gap between the two districts' results as reasons to expand one district at a time while watching outcomes closely.`,
  14: `A side benefit nobody had planned for showed up in vendor relations during the later months of the pilot: a handful of Cascadia managers started forwarding Aurelia's automatic discrepancy summaries straight to their vendor contacts instead of routing each one through procurement first. Two of Brightfield's biggest produce suppliers told Meridian's interviewers, independently of each other, that the cleaner, more consistent reports had cut down their own internal time spent resolving disputes, and one supplier even asked about setting up something similar with its other retail customers whether or not they used Aurelia.`,
  17: `Brightfield's earlier automation attempt from 2019, built on a different vendor's platform, is remembered internally as a flop, pulled after eight months once it became clear its rigid workflow couldn't flex to match how differently the two districts actually operated day to day. Meridian tackled that history directly in its pitch, framing Aurelia's adjustable rule sets as a deliberate fix for exactly the weakness that sank the earlier tool, and several regional directors said that willingness to name the 2019 failure outright was part of why they agreed to try automation again at all.`,
};

const heavySegments: ComposedSegment[] = BASE_PARAGRAPHS.map((p, i) =>
  HEAVY_REWRITES[i] ? { text: HEAVY_REWRITES[i], origin: "rewritten" as const } : { text: p, origin: "base-verbatim" as const },
);
export const HEAVY_EDIT_DOCUMENT = joinSegments(heavySegments);
export const HEAVY_EDIT_PERCENT = percentModified(heavySegments);

// --- F: PARTIAL_COPY (target 30-40% copied) -------------------------------------
// Paragraphs 5-8 (results/staffing/cost — a contiguous, plausible excerpt to
// copy) verbatim, followed by substantial NEW material on a deliberately
// unrelated fictional topic (a payment-processor incident postmortem) so the
// "new" 60-70% shares no distinctive vocabulary with the base document.

const UNRELATED_FILLER_PARAGRAPHS: string[] = [
  `At 03:14 UTC on the incident date, Solace Payments' on-call engineering rotation received the first of what would become several hundred automated alerts indicating elevated latency on the primary authorization-routing service. Initial triage suggested a routine traffic spike, and the on-call engineer applied the standard auto-scaling override used for such events before returning to a secondary monitoring channel.`,
  `Within eleven minutes, authorization success rates across the eastern processing cluster fell from a typical ninety-nine point six percent to just under seventy-one percent, triggering the company's severity-one incident protocol and paging the full incident-response bridge rather than the on-call engineer alone.`,
  `The response team's early hypothesis centered on a recently deployed configuration change to the fraud-scoring subsystem, since its rollout window overlapped closely with the onset of elevated latency; a rollback of that change was initiated at 03:41 UTC as a precautionary measure while deeper diagnostics continued in parallel.`,
  `The rollback restored authorization success rates to roughly ninety-four percent within nine minutes, but a residual latency signature persisted, leading the team to suspect a second, independent contributing factor rather than a single root cause.`,
  `Further investigation traced the residual latency to a connection-pool exhaustion condition in a shared database proxy layer, caused by an unrelated batch reporting job that had been rescheduled earlier that week to run during a window that, due to a daylight-saving-time discrepancy in the scheduling configuration, now overlapped with peak authorization traffic for the first time.`,
  `Terminating the misscheduled batch job at 04:22 UTC returned authorization success rates to their historical baseline within four minutes, and the incident was formally declared resolved at 04:31 UTC, a total duration of one hour and seventeen minutes from the first automated alert.`,
  `The subsequent postmortem identified two independent contributing factors — the fraud-scoring configuration change and the daylight-saving-time scheduling discrepancy — and noted that neither factor alone would likely have caused a severity-one incident, but that their coincidental overlap produced a compounding effect that neither the deployment review process nor the batch-scheduling review process was designed to catch in isolation.`,
  `Remediation items arising from the postmortem included a cross-team deployment calendar visible to both the payments engineering group and the data-platform group, a change to the batch-scheduling system requiring explicit timezone confirmation rather than an inherited default, and a new pre-deployment check requiring fraud-scoring configuration changes to be validated against a synthetic peak-traffic replay before reaching production.`,
  `Customer impact during the seventy-seven-minute incident window was estimated at roughly forty-one thousand declined transactions that would otherwise have been approved, based on a comparison against the prior four weeks' baseline decline rate at the same time of day; Solace's merchant-communications team issued a proactive notice to the twelve highest-volume merchants on the affected cluster within twenty minutes of the severity-one declaration, ahead of the company's standard forty-five-minute notification target for incidents of that severity.`,
  `A separate workstream within the postmortem examined why the fraud-scoring configuration change had passed its existing review process despite being one of the two contributing factors; the review concluded that the change itself was not defective in isolation; and that the existing review checklist had no step that would have surfaced its interaction with a concurrently scheduled batch job, since the two systems were owned by different teams and had historically been reviewed independently of one another.`,
  `The engineering organization also used the incident to revisit its severity-one paging thresholds more broadly, concluding that the eleven-minute gap between the first automated alert and the escalation to a full incident bridge was longer than desired for an authorization-success-rate drop of that magnitude, and proposing a tightened threshold that would have triggered full-bridge paging within approximately four minutes under the same conditions.`,
  `Finance and merchant-relations stakeholders were included in the postmortem review meeting for the first time under a newly adopted incident-review policy, on the reasoning that transaction-volume-impacting incidents have direct financial and merchant-trust consequences that the engineering-only postmortem format used previously had not been structured to capture systematically.`,
  `The final postmortem document was circulated to all engineering teams company-wide, not only the two teams directly involved, accompanied by a short recorded walkthrough of the incident timeline; attendance at the optional follow-up review session was tracked and, at just under sixty percent of eligible engineers, was cited internally as evidence that the blameless postmortem format introduced two years earlier had meaningfully increased organic engagement with incident learnings compared to the mandatory-attendance format it replaced.`,
];

const partialCopySegments: ComposedSegment[] = [
  ...BASE_PARAGRAPHS.slice(4, 8).map((p) => ({ text: p, origin: "base-verbatim" as const })),
  ...UNRELATED_FILLER_PARAGRAPHS.map((p) => ({ text: p, origin: "new" as const })),
];
export const PARTIAL_COPY_DOCUMENT = joinSegments(partialCopySegments);
export const PARTIAL_COPY_PERCENT_COPIED = 1 - percentModified(partialCopySegments);

// --- G: COMMON_PHRASE_ONLY -------------------------------------------------------
// Generic academic/business boilerplate only — deliberately shares no
// distinctive vocabulary with BASE_DOCUMENT (no Meridian/Aurelia/Brightfield/
// Cascadia/Highveld/reconciliation, etc.).

export const COMMON_PHRASE_ONLY_DOCUMENT = [
  `Introduction. The purpose of this report is to provide an overview of the topic under consideration.`,
  `This document examines the results of the analysis in question and presents a general summary of the findings.`,
  `The results of this study indicate that further review of the subject matter may be warranted going forward.`,
  `In light of the foregoing, it should be noted that additional research would likely be beneficial in this area.`,
  `The discussion above is intended to summarize the key points raised during the course of this review.`,
  `Overall, the findings presented in this document suggest that more work remains to be done on this topic.`,
  `This paper examines the subject in question and offers a number of general observations for consideration.`,
  `In conclusion, this report has shown that the matter discussed herein warrants continued attention and further study.`,
  `The purpose of this analysis is to consider the topic at hand from a general perspective.`,
  `Taken as a whole, the material presented above provides a reasonable basis for further discussion of the subject.`,
].join(" ");

// --- H: SAME_TOPIC_DIFFERENT_WORDING ---------------------------------------------
// Same abstract subject (a retail chain piloting workflow automation to cut
// administrative labor) but a different company, different platform, a
// different specific task focus (shift scheduling rather than inventory
// reconciliation), different structure (Q&A rather than narrative), and
// different numbers/examples throughout — engineered to share no
// distinctive text with BASE_DOCUMENT beyond common vocabulary.

export const SAME_TOPIC_DIFFERENT_WORDING_DOCUMENT = [
  `Q: Why did Solstice Retail Group start looking at scheduling automation in the first place?`,
  `A: Store leads kept telling head office that building the weekly shift roster took far longer than it should, especially around holidays and school-term changes when availability shifts constantly across a large part-time workforce. A time-motion study across a sample of twenty-two stores put the average at just over six hours a week per location, most of it spent manually cross-checking availability forms against a spreadsheet template that nobody particularly liked using.`,
  `Q: What did the Wayfinder rollout actually look like?`,
  `A: Nine stores in the Lower Dells region got the full Wayfinder scheduling suite, which lets staff submit availability through a phone app and automatically proposes a draft roster that a shift lead can approve or adjust rather than build from a blank sheet. Eight comparison stores in the neighboring Millbrook region kept doing things the old way for the same twelve-week stretch, so the two groups could be compared directly.`,
  `Q: What changed for the stores that got Wayfinder?`,
  `A: Shift leads in the Lower Dells group reported the roster-building task shrinking from roughly six hours to under two hours a week on average, and several specifically mentioned that the biggest relief was not re-keying availability information that staff had already submitted once through the app. A couple of leads did flag that the app's shift-swap feature caused confusion in the first few weeks, since staff weren't used to needing manager approval for swaps that used to happen informally by text message.`,
  `Q: Did anything unexpected come up during the trial?`,
  `A: Two of the nine Lower Dells stores share a single overnight stocking team that rotates between them, and Wayfinder's scheduling model initially treated each store as fully independent, which produced a run of double-booked shifts for that shared team during the second week. A manual override process was put in place while the vendor built a proper shared-team feature, which shipped in week seven and eliminated the double-booking problem going forward.`,
  `Q: What's the recommendation coming out of this?`,
  `A: Head office is leaning toward a wider trial next quarter, but specifically wants any store with a shared or rotating team assignment held back until the shared-team feature has a few more months of real-world use behind it, since that was the one place the trial surfaced a genuine gap rather than just an adjustment period.`,
].join("\n\n");

export type FixtureCategory =
  | "EXACT_COPY" | "FORMATTING_ONLY" | "LIGHT_EDIT" | "MODERATE_EDIT" | "HEAVY_EDIT"
  | "PARTIAL_COPY" | "COMMON_PHRASE_ONLY" | "SAME_TOPIC_DIFFERENT_WORDING";

export type Fixture = {
  category: FixtureCategory;
  label: string;
  text: string;
  targetModifiedPercentRange: [number, number] | null;
  actualModifiedPercent: number | null;
  expectedStatus: "MATCHED" | "NO_HISTORICAL_MATCH";
};

export const CALIBRATION_FIXTURES: Fixture[] = [
  { category: "EXACT_COPY", label: "A. Exact copy", text: BASE_DOCUMENT, targetModifiedPercentRange: [0, 0], actualModifiedPercent: 0, expectedStatus: "MATCHED" },
  { category: "FORMATTING_ONLY", label: "B. Formatting-only copy", text: FORMATTING_ONLY_DOCUMENT, targetModifiedPercentRange: [0, 0], actualModifiedPercent: 0, expectedStatus: "MATCHED" },
  { category: "LIGHT_EDIT", label: "C. Light edit", text: LIGHT_EDIT_DOCUMENT, targetModifiedPercentRange: [0.05, 0.10], actualModifiedPercent: LIGHT_EDIT_PERCENT, expectedStatus: "MATCHED" },
  { category: "MODERATE_EDIT", label: "D. Moderate edit", text: MODERATE_EDIT_DOCUMENT, targetModifiedPercentRange: [0.20, 0.30], actualModifiedPercent: MODERATE_EDIT_PERCENT, expectedStatus: "MATCHED" },
  { category: "HEAVY_EDIT", label: "E. Heavy edit", text: HEAVY_EDIT_DOCUMENT, targetModifiedPercentRange: [0.40, 0.60], actualModifiedPercent: HEAVY_EDIT_PERCENT, expectedStatus: "MATCHED" },
  { category: "PARTIAL_COPY", label: "F. Partial copy", text: PARTIAL_COPY_DOCUMENT, targetModifiedPercentRange: [0.30, 0.40], actualModifiedPercent: PARTIAL_COPY_PERCENT_COPIED, expectedStatus: "MATCHED" },
  { category: "COMMON_PHRASE_ONLY", label: "G. Common-phrase only", text: COMMON_PHRASE_ONLY_DOCUMENT, targetModifiedPercentRange: null, actualModifiedPercent: null, expectedStatus: "NO_HISTORICAL_MATCH" },
  { category: "SAME_TOPIC_DIFFERENT_WORDING", label: "H. Same topic, different wording", text: SAME_TOPIC_DIFFERENT_WORDING_DOCUMENT, targetModifiedPercentRange: null, actualModifiedPercent: null, expectedStatus: "NO_HISTORICAL_MATCH" },
];
