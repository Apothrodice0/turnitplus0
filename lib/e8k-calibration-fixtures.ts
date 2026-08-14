import { tokens } from "./similarity-core";
import {
  BASE_DOCUMENT as E8J_BASE_DOCUMENT,
  CALIBRATION_FIXTURES as E8J_CALIBRATION_FIXTURES,
} from "./e8j-calibration-fixtures";

/**
 * Phase E8K: additional synthetic fixtures for passage-level acceptance
 * calibration. Everything here is invented for this phase — a fictional
 * deep-sea research narrative, generic academic boilerplate, and a
 * fictional library-renovation filler topic — none of it overlaps with the
 * real archive, any real user document, or E8J's retail-automation content
 * beyond directly re-exporting E8J's own fixtures (reused, not duplicated,
 * for the fixtures this phase's spec explicitly asks to reuse — section 5-10,
 * 14). This module has no DB access and performs no I/O.
 */

export { E8J_BASE_DOCUMENT };
export const E8J_FIXTURES = E8J_CALIBRATION_FIXTURES;

// --- raw word slicing (preserves original text; not the same as tokens()) ---

function takeRawWords(text: string, n: number): string {
  return text.trim().split(/\s+/).slice(0, n).join(" ");
}

// --- HIST_DISTINCTIVE: a fictional deep-sea expedition narrative, in 4 clearly
// separated zones so excerpts of different sizes/purposes never overlap. ------

export const EXCERPT_ZONE_TEXT =
  `The research vessel Kestrel Deep departed its home port on the ninth of March carrying a twelve-member science party assembled to survey an uncharted section of seafloor roughly four thousand meters down, where an earlier sonar sweep had picked up a thermal anomaly consistent with hydrothermal venting. Chief scientist Elena Vasquez had spent the better part of eighteen months securing ship time for the expedition, arguing in her original proposal that the anomaly's location, well outside any previously surveyed vent field, made it a strong candidate for an entirely undocumented chemosynthetic community. The ship's remotely operated vehicle, a deep-rated unit nicknamed Pallas, was fitted with an additional suite of temperature and chemical sensors specifically for this cruise, since the standard instrument package was not considered sufficient to characterize a vent field of unknown chemistry before committing to expensive biological sampling. On the fourth day of operations, Pallas descended along a pre-planned survey line and, at a depth of three thousand nine hundred and twelve meters, its forward sonar returned a cluster of returns consistent with active venting roughly two hundred meters off the planned track. Vasquez authorized an immediate course change, and within forty minutes the vehicle's cameras captured the first visual confirmation: a field of at least six distinct chimney structures, the tallest estimated at just over four meters, venting a shimmering plume that the onboard chemical sensors registered as unusually rich in dissolved iron relative to every previously catalogued vent field in the region. The science party informally named the site the Amberline field, after the distinctive amber-tinted mineral precipitate visible on the chimney surfaces under the vehicle's lights. Sampling began the following day with a series of push-core collections from the sediment surrounding the largest chimney, chosen specifically because its plume showed the highest particulate density of any structure in the field. The push cores recovered a layered sediment sequence that the shipboard geologist described as unusually well preserved, with almost no evidence of the bioturbation typically seen at longer-established vent sites, suggesting the field itself might be geologically quite young. Water samples drawn at three different heights above the same chimney showed a temperature gradient far steeper than the team had anticipated, dropping from just under three hundred and forty degrees Celsius at the orifice to near-ambient conditions within less than two meters of vertical distance, a gradient Vasquez later described in her cruise log as the steepest she had personally measured at any vent site in over a decade of fieldwork. A biological survey conducted alongside the chemical sampling documented an unusually dense population of a previously uncatalogued species of vent shrimp clustering directly on the chimney's lower flanks, in numbers the team's biologist estimated at several thousand individuals within a roughly three-meter radius, a density notably higher than typical for the handful of comparable vent-shrimp species documented elsewhere in the ocean basin. Tissue samples were collected from a representative subset of the population for later genetic analysis, along with paired water-chemistry measurements intended to help establish whether the unusually high density correlated with the field's distinctive iron-rich plume chemistry or with some other, as yet unidentified, environmental factor specific to the Amberline site. The cruise's chief engineer noted afterward that Pallas performed markedly better in the unusually warm near-chimney water than earlier cold-water dive logs had suggested it would, a detail the engineering team flagged as worth investigating further given its possible relevance to future vehicle design for similarly hot vent environments elsewhere in the ocean.`;

export const MEDIUM_BLOCK_1 =
  `Midway through the fifth dive, Pallas experienced a partial failure of its starboard manipulator arm, losing fine-motor control while retaining basic open-close function, an issue the engineering team traced after recovery to a seal failure in the arm's primary hydraulic actuator likely caused by the unusually high ambient temperature near the chimney base. Rather than abort the dive entirely, the pilot elected to complete the planned sediment-core collection using the vehicle's port arm alone, a decision that added roughly ninety minutes to the dive but preserved the day's full sampling plan. The manipulator was replaced with a spare unit carried for exactly this contingency, and a post-dive inspection of the recovered arm suggested the seal failure was an isolated manufacturing defect rather than a design issue likely to recur across the vehicle's remaining dives for the cruise.`;

export const MEDIUM_BLOCK_2 =
  `On the next-to-last scheduled dive of the cruise, a routine transit between two sampling stations brought Pallas within visual range of a second, considerably smaller cluster of venting structures roughly eight hundred meters northeast of the main Amberline field, a discovery the science party had not anticipated given the relatively limited sonar coverage of that particular stretch of seafloor. With only one dive day remaining, Vasquez made the call to spend the bulk of the final dive characterizing rather than sampling the new cluster, reasoning that a rushed sampling effort risked contaminating specimens without meaningfully expanding the cruise's scientific yield, and that a well-documented visual and chemical survey would make a stronger case for securing ship time to return and sample the second cluster properly on a future expedition.`;

export const LONG_BLOCK =
  `In her preliminary cruise report, circulated to the funding program roughly six weeks after the ship returned to port, Vasquez emphasized three findings she considered most significant ahead of the fuller analysis still underway in shore-based laboratories. First, the iron-rich plume chemistry measured at the Amberline field's largest chimney was distinct enough from every previously catalogued vent field in the region that she argued it likely reflected a genuinely different subsurface geological setting rather than ordinary variation within a known vent-field type, a claim she flagged as needing confirmation through more detailed mineralogical analysis of the recovered chimney material. Second, the unusually low degree of sediment bioturbation observed in the push cores, combined with the steep near-orifice temperature gradient, together suggested the field was likely young relative to most previously studied vent systems, though she was careful to note that sediment-based age estimates of this kind carry substantial uncertainty without a directly dated mineral sample, which the cruise had not been equipped to collect. Third, and in her view most significant for future proposals, the discovery of the second, smaller vent cluster so close to the main field, entirely by chance during a routine transit, raised the possibility that the surveyed area contained a broader network of related venting rather than a single isolated field, a possibility with direct implications for how any follow-up cruise should structure its survey coverage. The report closed with a formal recommendation that the program prioritize a return expedition within the following two field seasons, both to complete proper biological sampling at the second cluster before conditions there potentially changed, and to conduct a wider sonar survey of the surrounding seafloor specifically to test whether additional undiscovered venting existed nearby. Several members of the science party who reviewed the draft report before submission suggested that the recommendation be strengthened further, citing the unusually high vent-shrimp density at the main field as itself a strong independent justification for prioritizing a return cruise regardless of how the geological questions were eventually resolved, though Vasquez ultimately kept the report's language measured, noting in her cover email that overstating the case in a preliminary report risked undermining the credibility of the funding request rather than strengthening it.`;

export const HIST_DISTINCTIVE_DOCUMENT = [EXCERPT_ZONE_TEXT, MEDIUM_BLOCK_1, MEDIUM_BLOCK_2, LONG_BLOCK].join("\n\n");

// --- HIST_GENERIC: generic academic boilerplate + a handful of short common
// snippets — deliberately shares vocabulary with the generic/common-overlap
// query fixtures below, unlike E8J's COMMON_PHRASE_ONLY (which shared nothing
// with E8J's base document and so trivially never even generated a
// candidate). The point here is the opposite: force real shingle overlap so
// distinctiveness scoring has something non-trivial to discriminate. --------

export const GENERIC_BOILERPLATE_POOL =
  `This section provides a general overview of the material discussed throughout the remainder of the document. The analysis presented below is intended to summarize the principal findings arising from the review process. Readers should note that the discussion that follows reflects a broad synthesis of the available information rather than an exhaustive treatment of every possible consideration. The purpose of the following discussion is to place the results within their appropriate broader context. It should further be noted that the conclusions offered here are necessarily provisional pending additional review. The material presented in this section is organized to proceed from general observations toward more specific points of interest. Taken together, the observations summarized above provide a reasonable basis for the recommendations that follow. The present discussion does not attempt to resolve every open question raised during the course of the review, several of which are noted for further consideration elsewhere. In general terms, the findings described here are consistent with expectations formed prior to the start of the review process. The following paragraphs summarize the key considerations that informed the approach adopted throughout this document. As is often the case in work of this kind, several practical constraints shaped the scope of what could reasonably be addressed within the available time and resources. The remaining sections proceed to examine each of these considerations in turn, beginning with the most general and moving toward the more specific. It is worth noting at the outset that the present discussion draws on a range of sources whose relative weight is considered further below. The overall structure of the discussion reflects a deliberate choice to present broader context before turning to more detailed analysis. Additional detail on several of the points raised above is provided in the sections that follow. The reader is encouraged to consult the supporting material referenced throughout for a fuller treatment of any point discussed only briefly here. Taken as a whole, the discussion presented in this document is intended to support further consideration of the issues raised rather than to offer a final or definitive treatment of any single point. Subsequent sections build on the general framework introduced here, extending the discussion to more specialized considerations that fall outside the scope of this introductory material. Where appropriate, cross-references are provided to help readers locate related discussion elsewhere in the document without needing to consult the material presented here in its entirety. The approach adopted throughout reflects a preference for clarity and accessibility over exhaustive technical detail, on the view that a broader readership is better served by a discussion that remains approachable throughout. Certain terms used repeatedly throughout the discussion are defined more precisely in later sections, and readers unfamiliar with the relevant background are encouraged to consult those definitions before proceeding further.`;

export const SHORT_COMMON_SNIPPETS: string[] = [
  "The results were broadly consistent with expectations and further analysis is recommended before drawing firm conclusions.",
  "No significant deviation from the anticipated pattern was observed during the course of the review.",
  "Additional data collection would likely strengthen confidence in the preliminary findings reported here.",
  "The observed trend persisted across each of the conditions examined during the review process.",
  "Further investigation into this particular aspect falls outside the scope of the present discussion.",
  "These findings should be interpreted with appropriate caution given the limited scope of the review.",
  "A more detailed treatment of this topic is provided in the supporting material referenced above.",
  "The general pattern described here is consistent with similar observations reported elsewhere previously.",
];

export const HIST_GENERIC_DOCUMENT = [GENERIC_BOILERPLATE_POOL, SHORT_COMMON_SNIPPETS.join(" ")].join("\n\n");

/**
 * A second, otherwise-unrelated historical document that independently
 * reuses a handful of GENERIC_BOILERPLATE_POOL's own sentences — simulating
 * "many real documents happen to use this same generic phrasing." Included
 * in LOCAL_HISTORICAL_CORPUS specifically so the distinctiveness rarity
 * measure (lib/e8k-passage-evaluator.ts's corpusRarity) has a genuine signal
 * to detect generic text as low-distinctiveness, rather than the local
 * corpus being too small/topically-disjoint to ever demonstrate the
 * mechanism working at all — see this phase's own final report, section 11.
 */
export const SECONDARY_REVIEW_DOCUMENT =
  `This section provides a general overview of the material discussed throughout the remainder of the document. The analysis presented below is intended to summarize the principal findings arising from the review process. Readers should note that the discussion that follows reflects a broad synthesis of the available information rather than an exhaustive treatment of every possible consideration. A separate committee reviewed the proposed zoning amendment over three sessions held between April and June, hearing testimony from eleven residents and two representatives of the regional planning office before voting five to two in favor of forwarding the amendment to the full council with two minor revisions to its buffer-zone language. It should further be noted that the conclusions offered here are necessarily provisional pending additional review. The material presented in this section is organized to proceed from general observations toward more specific points of interest. The committee's revised buffer-zone language extends the required setback from adjacent residential parcels by an additional fifteen feet along the amendment's northern boundary, a change proposed directly in response to concerns raised during the second hearing session.`;

// --- unrelated filler (a fictional library renovation) — combined with
// excerpts above to build the actual query fixtures for sections 11/13. ------

export const FILLER_PARAGRAPHS: string[] = [
  `The Fernhollow branch library's renovation committee held its first public planning session on a Tuesday evening in late January, with roughly two dozen residents attending to review three competing design concepts prepared by the architecture firm retained the previous autumn.`,
  `The most debated element across all three concepts was the fate of the reading room's original nineteen-fifties skylight, which the firm's structural assessment had flagged as a significant source of heat loss but which several longtime patrons argued was the room's single most distinctive architectural feature.`,
  `A compromise eventually emerged in which the skylight's exterior glazing would be replaced with a modern insulated equivalent while its interior wood framing, largely original, would be retained and restored rather than removed, a solution the committee's chair described as satisfying both the energy-efficiency requirements attached to the renovation grant and the preservation concerns raised at the first meeting.`,
  `Budget discussions at the second session focused heavily on the children's section, where the winning concept proposed converting an underused storage annex into a dedicated early-literacy space, a change that would require relocating the library's local-history archive to a smaller room on the building's upper floor.`,
  `Several archive volunteers raised concerns about the proposed relocation, particularly regarding humidity control in the upper-floor room, and the committee ultimately agreed to commission a separate environmental assessment of that space before finalizing the archive's new location.`,
  `Construction is currently scheduled to begin after the branch's summer reading program concludes, with the library expected to operate out of a temporary storefront location roughly four blocks away for the duration of the work, an arrangement the head librarian described as disruptive but manageable given the temporary space's proximity to the original building.`,
];
export const FILLER_TEXT = FILLER_PARAGRAPHS.join(" ");

function withFiller(excerpt: string): string {
  // Filler both before and after so a matched excerpt is never at a
  // document boundary — a slightly more realistic placement.
  return `${FILLER_PARAGRAPHS[0]} ${FILLER_PARAGRAPHS[1]}\n\n${excerpt}\n\n${FILLER_PARAGRAPHS[2]} ${FILLER_PARAGRAPHS[3]} ${FILLER_PARAGRAPHS[4]} ${FILLER_PARAGRAPHS[5]}`;
}

// --- section 11: small distinctive passages of increasing size --------------

export const SMALL_PASSAGE_100 = withFiller(takeRawWords(EXCERPT_ZONE_TEXT, 100));
export const SMALL_PASSAGE_150 = withFiller(takeRawWords(EXCERPT_ZONE_TEXT, 150));
export const SMALL_PASSAGE_250 = withFiller(takeRawWords(EXCERPT_ZONE_TEXT, 250));
export const SMALL_PASSAGE_500 = withFiller(takeRawWords(EXCERPT_ZONE_TEXT, 500));

// --- section 12: generic text of increasing length, standalone (no filler) --
// — standalone and NOT mixed with filler, so a "pass" would have to come
// purely from the generic content itself, exactly matching section 12's
// "should not be accepted merely because they are contiguous" framing.

export const GENERIC_100 = takeRawWords(GENERIC_BOILERPLATE_POOL, 100);
export const GENERIC_200 = takeRawWords(GENERIC_BOILERPLATE_POOL, 200);
export const GENERIC_300 = takeRawWords(GENERIC_BOILERPLATE_POOL, 300);

// --- section 13: many short / several medium / one long ----------------------

export const MANY_SHORT_COMMON_OVERLAPS = [
  FILLER_PARAGRAPHS[0], SHORT_COMMON_SNIPPETS[0], FILLER_PARAGRAPHS[1], SHORT_COMMON_SNIPPETS[1],
  FILLER_PARAGRAPHS[2], SHORT_COMMON_SNIPPETS[2], FILLER_PARAGRAPHS[3], SHORT_COMMON_SNIPPETS[3],
  FILLER_PARAGRAPHS[4], SHORT_COMMON_SNIPPETS[4], FILLER_PARAGRAPHS[5], SHORT_COMMON_SNIPPETS[5],
  SHORT_COMMON_SNIPPETS[6], SHORT_COMMON_SNIPPETS[7],
].join(" ");

export const SEVERAL_MEDIUM_DISTINCTIVE_OVERLAPS = withFiller(`${MEDIUM_BLOCK_1}\n\n${FILLER_PARAGRAPHS[2]}\n\n${MEDIUM_BLOCK_2}`);

export const ONE_LONG_DISTINCTIVE_OVERLAP = withFiller(LONG_BLOCK);

// --- section 14: same-topic, different wording (reused from E8J directly) --

export const SAME_TOPIC_DOCUMENT = E8J_CALIBRATION_FIXTURES.find((f) => f.category === "SAME_TOPIC_DIFFERENT_WORDING")!.text;

// --- fixture registry ---------------------------------------------------------

export type E8KFixtureCategory =
  | "SMALL_PASSAGE_100" | "SMALL_PASSAGE_150" | "SMALL_PASSAGE_250" | "SMALL_PASSAGE_500"
  | "GENERIC_100" | "GENERIC_200" | "GENERIC_300"
  | "MANY_SHORT_COMMON" | "SEVERAL_MEDIUM_DISTINCTIVE" | "ONE_LONG_DISTINCTIVE"
  | "SAME_TOPIC_DIFFERENT_WORDING";

export type E8KFixture = {
  category: E8KFixtureCategory;
  label: string;
  text: string;
  candidateText: string;
  candidateLabel: string;
  expectedShouldDetect: boolean;
};

export const E8K_FIXTURES: E8KFixture[] = [
  { category: "SMALL_PASSAGE_100", label: "100-word distinctive passage", text: SMALL_PASSAGE_100, candidateText: HIST_DISTINCTIVE_DOCUMENT, candidateLabel: "HIST_DISTINCTIVE", expectedShouldDetect: false },
  { category: "SMALL_PASSAGE_150", label: "150-word distinctive passage", text: SMALL_PASSAGE_150, candidateText: HIST_DISTINCTIVE_DOCUMENT, candidateLabel: "HIST_DISTINCTIVE", expectedShouldDetect: true },
  { category: "SMALL_PASSAGE_250", label: "250-word distinctive passage", text: SMALL_PASSAGE_250, candidateText: HIST_DISTINCTIVE_DOCUMENT, candidateLabel: "HIST_DISTINCTIVE", expectedShouldDetect: true },
  { category: "SMALL_PASSAGE_500", label: "500-word distinctive passage", text: SMALL_PASSAGE_500, candidateText: HIST_DISTINCTIVE_DOCUMENT, candidateLabel: "HIST_DISTINCTIVE", expectedShouldDetect: true },
  { category: "GENERIC_100", label: "100 generic academic words", text: GENERIC_100, candidateText: HIST_GENERIC_DOCUMENT, candidateLabel: "HIST_GENERIC", expectedShouldDetect: false },
  { category: "GENERIC_200", label: "200 generic academic words", text: GENERIC_200, candidateText: HIST_GENERIC_DOCUMENT, candidateLabel: "HIST_GENERIC", expectedShouldDetect: false },
  { category: "GENERIC_300", label: "300 generic academic words", text: GENERIC_300, candidateText: HIST_GENERIC_DOCUMENT, candidateLabel: "HIST_GENERIC", expectedShouldDetect: false },
  { category: "MANY_SHORT_COMMON", label: "Many short common overlaps", text: MANY_SHORT_COMMON_OVERLAPS, candidateText: HIST_GENERIC_DOCUMENT, candidateLabel: "HIST_GENERIC", expectedShouldDetect: false },
  { category: "SEVERAL_MEDIUM_DISTINCTIVE", label: "Several medium distinctive overlaps", text: SEVERAL_MEDIUM_DISTINCTIVE_OVERLAPS, candidateText: HIST_DISTINCTIVE_DOCUMENT, candidateLabel: "HIST_DISTINCTIVE", expectedShouldDetect: true },
  { category: "ONE_LONG_DISTINCTIVE", label: "One long distinctive overlap", text: ONE_LONG_DISTINCTIVE_OVERLAP, candidateText: HIST_DISTINCTIVE_DOCUMENT, candidateLabel: "HIST_DISTINCTIVE", expectedShouldDetect: true },
  { category: "SAME_TOPIC_DIFFERENT_WORDING", label: "Same topic, different wording", text: SAME_TOPIC_DOCUMENT, candidateText: E8J_BASE_DOCUMENT, candidateLabel: "E8J_BASE_DOCUMENT", expectedShouldDetect: false },
];

/** The small local "historical corpus" used for distinctiveness rarity scoring — see lib/e8k-passage-evaluator.ts's own comment on why a small local set, not a real corpus-wide system, is what this phase calibrates. */
export const LOCAL_HISTORICAL_CORPUS: { id: string; canonicalText: string }[] = [
  { id: "e8j-base", canonicalText: E8J_BASE_DOCUMENT },
  { id: "hist-distinctive", canonicalText: HIST_DISTINCTIVE_DOCUMENT },
  { id: "hist-generic", canonicalText: HIST_GENERIC_DOCUMENT },
  { id: "secondary-review", canonicalText: SECONDARY_REVIEW_DOCUMENT },
];

export function wordCount(text: string): number {
  return tokens(text).length;
}
