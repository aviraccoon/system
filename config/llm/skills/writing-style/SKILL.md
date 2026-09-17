---
name: writing-style
description: Write prose that reads as human-written rather than LLM-generated. Use when writing or reviewing docs, posts, READMEs, commit messages, or handouts.
---

# LLM Writing Guide

Reference for steering LLM output toward better writing.

Distinguishes between patterns that are always problematic vs. context-dependent choices.

---

## Core Problem: Regression to the Mean

LLMs predict likely next tokens based on training data. Output regresses toward the mean: less specific, more exaggerated.

The fix: specificity over grandiosity. Be direct. Let readers draw their own conclusions about importance.

---

## Always Problematic

These patterns are bad regardless of context.

### Importance Inflation

**Words to avoid**: *stands/serves as*, *is a testament/reminder*, *plays a vital/significant/crucial/pivotal role*, *underscores/highlights its importance*, *impactful*, *reflects broader*, *symbolizing its ongoing/enduring/lasting impact*, *key turning point*, *indelible mark*, *deeply rooted*, *profound heritage*, *revolutionary*, *tapestry* (abstract)

**The problem**: Asserting significance rather than demonstrating it. Even mundane details get wrapped in importance language.

**Examples**:
- "This etymology highlights the enduring legacy of the community's resistance"
- "Marking a pivotal moment in the evolution of..."
- "Solidifying its role as a regional hub"

**Instead**: State specific facts. If something is important, the facts will show it.

### Superficial Analysis (Participle Tacking)

**Words to avoid**: *ensuring...*, *reflecting...*, *conducive/tantamount/contributing to...*, *cultivating...*, *encompassing...*, *essentially/fundamentally is...*, *valuable insights*

**The problem**: Attaching shallow analytical phrases (often "-ing" clauses) at the end of sentences, synthesizing conclusions from nowhere.

**Examples**:
- "...creating a lively community within its borders"
- "...shaping their values, community structures, and approaches to political engagement"
- "...driving a commitment to empowerment and social change that echoes through generations"

**Instead**: Present facts. If analysis is needed, make it substantive and specific—not a vague phrase tacked onto a sentence.

### Promotional Puffery

**Words to avoid**: *continues to captivate*, *groundbreaking* (figurative), *stunning natural beauty*, *enduring/lasting legacy*, *nestled*, *in the heart of*, *boasts a...*, *offers visitors a fascinating glimpse*

**The problem**: Text reads like tourism brochures or marketing copy.

**Instead**: Describe without selling. State what exists rather than how wonderful it is.

### AI Vocabulary Clusters

**Words to watch**: *Additionally* (starting sentences), *align with*, *crucial*, *delve*, *emphasizing*, *enduring*, *enhance*, *fostering*, *garner*, *highlight* (as verb), *interplay*, *intricate/intricacies*, *landscape* (abstract), *pivotal*, *showcase*, *testament*, *underscore* (verb), *valuable*, *vibrant*

**The problem**: LLMs overuse specific words far more frequently than humans. Where there's one, there are usually others in the same passage.

**Example**:
> "An enduring testament to the influence... showcasing how these dishes have integrated... Additionally, merchants played a pivotal role..."

**Instead**: Use varied, precise vocabulary chosen for accuracy, not impressive sound.

### Vague Attribution

**Words to avoid**: *Industry reports*, *Observers have cited*, *Experts argue*, *Some critics argue*, *has been described as*

**The problem**: Attributing opinions to vague authorities while citing sources that may not express those views.

**Example**:
> "His compositions have been described as exploring conceptual themes..." (when the only source is his own website)

**Instead**: Attribute specifically. Name sources. Don't inflate individual opinions into consensus.

### Elegant Variation (Synonym Chains)

**The problem**: Repetition-penalty causes awkward synonym chains (protagonist → key player → eponymous character → the individual in question).

**Instead**: Repeat words when clarity requires it. Don't sacrifice clarity for forced variety.

### False Ranges

**The problem**: Misusing "from X to Y" where no meaningful scale exists between endpoints.

**Example**:
> "From the birth and death of stars to the enigmatic dance of dark matter..."

**Instead**: Only use "from X to Y" when a genuine scale or spectrum connects the endpoints.

### Formulaic Challenges/Future Sections

**The problem**: Ending with a rigid formula: acknowledge challenges, pivot to vague optimism.

**Example**:
> "Despite its industrial prosperity, [Subject] faces challenges typical of urban areas... With its strategic location and ongoing initiatives, [Subject] continues to thrive..."

**Instead**: If challenges exist, discuss them specifically. Don't force optimistic conclusions.

### Over-Hedging

**Words to avoid**: *may*, *might*, *could potentially*, *it's possible that*, *in some cases*, *depending on circumstances*, *it's worth noting that*

**The problem**: Excessive caution. Adding unnecessary qualifiers to every statement. The opposite of puffery but equally annoying.

**Example**:
> "This approach may potentially help in some cases, depending on the specific circumstances and requirements that might apply."

**Instead**: Make direct statements. Qualify only when uncertainty is genuinely relevant.

### Filler Phrases

**Phrases to avoid**: *In terms of*, *When it comes to*, *It is important to note that*, *It should be mentioned that*, *With regard to*, *In the context of*, *As a matter of fact*

**The problem**: Phrases that add words without adding meaning.

**Example**:
> "When it comes to performance, it is important to note that in terms of speed, the system performs well."

**Instead**: "The system is fast."

### Verbosity

**The problem**: Using 20 words where 8 would do. Restating things multiple ways. Adding unnecessary detail.

**Example**:
> "The process of migrating the database involved a series of steps that were undertaken over a period of time in order to ensure that the transition was completed successfully."

**Instead**: "The database migration took three weeks."

Brevity is not rudeness. Concise writing respects the reader's time.

### Collaborative Language Leakage

**Words to avoid**: *I hope this helps*, *Of course!*, *Certainly!*, *You're absolutely right!*, *Would you like...*, *is there anything else*, *let me know*, *here is a...*

**The problem**: Including conversational language meant for chat, not final output.

**Instead**: Output only the final content. No meta-commentary about the writing process.

### Staccato Overcorrection

**The problem**: When fixing verbosity or em dash overuse, the instinct is to break everything into short sentences. This creates robotic, choppy prose that sounds like a PowerPoint deck.

**Example**:
> "Same person. Same skills. Different position. The difference wasn't communication. It was structural."

**Instead**: Vary sentence length. Combine related thoughts. Short sentences work for emphasis, not as the default.

### Defensive Disclaimers

**Phrases to watch**: *This isn't about X*, *This isn't laziness*, *This isn't bad faith*, *Not because of X, but because of Y*

**The problem**: Preemptively addressing potential criticism before making a point. Once is fine. Three times in one piece is a pattern. Reads as anxious rather than confident.

**Instead**: Make the point. If it's clear, the reader won't assume the thing you're defending against.

### Validation Echoes

**Phrases to watch**: *X is real*, *X is legitimate*, *X concerns are valid*, *X constraints exist*

**The problem**: Used to signal nuance and empathy, but becomes repetitive filler when multiple appear in one piece. Usually removable without losing meaning.

**Instead**: If you're acknowledging a counterpoint, make it specific rather than just validating it exists.

### Academic Register Creep

**The problem**: Reaching for precise-sounding academic vocabulary instead of plain language. Words like *diffuse*, *acute*, *locally rational*, *transmission*. One or two are fine; clusters of them shift the register away from natural writing into essay-speak.

**Instead**: Use the simple word unless the academic one adds precision the simple one can't.

### Word Echo

**The problem**: Reusing a distinctive word (like "structural" or "regardless") multiple times without noticing. Different from Elegant Variation (synonym chains) -- this is the opposite problem. AI doesn't track word frequency across paragraphs.

**Instead**: After writing, scan for distinctive words that appear more than twice. Either cut instances or find actual alternatives (not forced synonyms).

### Section Summaries

**Words to avoid**: *In summary*, *In conclusion*, *Overall*

**The problem**: Adding concluding sections that restate content.

**Instead**: End sections when the content ends. Don't summarize unless genuinely useful.

---

## Context-Dependent Choices

These aren't inherently bad—they depend on the writing context, audience, and style.

### Tone and Voice

Tone should match context. There's no single "correct" voice:

| Context | Appropriate tone |
|---------|------------------|
| Team documentation | Professional, objective, detailed, third-person |
| Personal blog/project | Playful, opinionated, first-person, personality welcome |
| Technical reference | Clear, precise, minimal flourish |
| User-facing docs | Accessible, helpful, appropriate formality for audience |

A commit history doc for coworkers shouldn't read like a personal blog post. A fun side project's README shouldn't read like corporate documentation. Match the tone to who's reading and why.

### Title Case vs Sentence Case

Title Case headings are fine in many contexts (documentation, personal writing, blog posts). The Wikipedia guide flags it because their style guide specifies sentence case. Follow whatever style guide applies to your context.

### Bold for Emphasis

Bold can be used purposefully for key concepts, philosophy statements, or important terms. The problem is mechanical emphasis of every keyword like a sales pitch. Intentional bold on key ideas is fine.

### Tables

Tables are excellent for reference material, comparisons, and structured data. The problem is unnecessary small tables for information better presented as prose. Use tables when they genuinely help—which is often.

### Em Dashes

Em dashes are a normal punctuation choice. The problem is formulaic overuse mimicking "punched up" sales writing. Natural use of em dashes in moderation is fine.

### Inline-Header Lists

Lists with bold headers can be useful for reference documentation:

| Approach | Best for |
|----------|----------|
| Prose | Narrative, explanation |
| Simple bullets | Quick enumeration |
| Header lists | Reference material with explanations |

The problem is using this format mechanically for everything.

### Rule of Three

Sometimes three items are genuinely what you need. The problem is padding lists to three to seem comprehensive. Use the actual number of items relevant to your point.

### Negative Parallelisms

"Not only X but also Y" has legitimate uses for genuine contrast. The problem is mechanical overuse to appear balanced. Reserve for actual contrast.

---

## What Good AI Writing Looks Like

The common thread across all good writing: **specificity over vagueness**.

### Be Specific

Good (any context):
> "Supported formats: PNG, JPEG, WebP. Max file size: 5MB. Timeout: 30 seconds."

Bad:
> "Various file formats are supported with configurable size limits and appropriate timeout values."

### State Things Directly

Good:
> "No dependencies. No build step. No configuration."

Bad:
> "This framework enables a reduction in external requirements while fostering streamlined deployment patterns."

### Use Precise Language

Good:
> "The migration took 18 months. Python scripts were replaced one at a time."

Bad:
> "The migration process unfolded over an extended period, during which legacy components were systematically transitioned."

### Explain Why When It Matters

Good:
> "We use UUIDs instead of auto-increment IDs because merging databases with overlapping integer IDs causes conflicts."

Bad:
> "UUIDs are utilized for identifier generation in accordance with distributed systems best practices."

### Match Structure to Content

- Diagrams for architecture
- Tables for comparisons and reference data
- Prose for narrative and explanation
- Bullet lists for enumeration
- Code blocks for code

### Know When to Stop

End when content ends. No recaps unless the document is long enough to need one.

---

## The Core Principle

Good writing is specific, not generic. It states facts rather than asserting importance. It trusts readers to draw conclusions. It uses precise words rather than impressive-sounding ones. It matches tone to context and audience.

The fundamental problem with typical AI writing is regression toward the generic and impressive-sounding—fading specific details while amplifying claims of significance. Counter this by prioritizing specificity and directness over grandiosity.

---

*Adapted from [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)*
*Last updated: 2025-12-31*
