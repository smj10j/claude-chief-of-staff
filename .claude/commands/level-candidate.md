# Level Candidate

Assess an engineering candidate against your IC leveling framework. Produces a structured leveling recommendation.

## Arguments

The argument string is: $ARGUMENTS

Parse as: a candidate name, optionally followed by a Greenhouse PDF path or other context. If no arguments, ask for the candidate name and any available materials (resume, interview feedback PDF, Greenhouse link).

## Steps

1. **Gather materials**: Read any provided PDFs, resumes, or links. If a Greenhouse interview feedback PDF is provided, read all pages. If only a name is given, search Glean for interview feedback or Greenhouse records.

2. **Read the leveling framework and personal guidelines**: Read both:
   - `data/files/areas/career/eng-leveling-framework.md` — the full IC competency framework. Source of truth for level definitions.
   - `data/files/areas/career/leveling-guidelines.md` — your personal leveling philosophy, heuristics, and preferences distilled from past calibration feedback. Apply these throughout the assessment.

3. **Identify the target level range**: Based on the candidate's experience and the role they're interviewing for, identify 2-3 adjacent levels to evaluate against (e.g., L3/L4 or L4/L5).

4. **Map interview signal to framework dimensions**: For each of the three framework dimensions (Technical, Impact, Leadership & Mentorship), quote the specific competency language from the framework and cite specific interview evidence for or against. Use this format:

   ```
   ### Technical

   **L3 expectation**: "Drive projects within the team, designing and building systems of moderate complexity"
   **Evidence**: [specific interview signal with interviewer name and round]
   **Assessment**: Meets / Exceeds / Below

   **L4 expectation**: "Able to identify systemic team operational issues and propose, and drive implementation of solutions"
   **Evidence**: [specific interview signal]
   **Assessment**: Meets / Exceeds / Below
   ```

5. **Summarize the scorecard**: Present the overall interview panel results (interviewer, round, rating, key quote).

6. **Make a leveling recommendation**: Based on the framework mapping, recommend a level. Call out:
   - Which dimensions are strongest / weakest
   - Any gaps that are typical-for-level vs. concerning
   - How the debrief consensus (if available) aligns with your framework analysis
   - Comp/timeline context if available from recruiter screen

7. **Apply your personal heuristics**: After the framework mapping, re-read `data/files/areas/career/leveling-guidelines.md` and check the patterns it surfaces. Common heuristics to consider:
   - Over-complication in system design? (junior signal)
   - Sole-contributor background? (insufficient for senior IC)
   - Cross-domain leadership evidence? (required at higher levels)
   - AI-inflation risk? (polished summary vs raw scorecard mismatch)
   - Retention risk? (tenure patterns, relocation history)
   - Use the user's typical phrasing where appropriate (the guidelines doc captures their voice).

8. **Flag risks and development areas**: Note anything the hiring manager should watch for in the first 6 months, based on interview signal gaps.

## Rules

- Always use the actual framework language from `data/files/areas/career/eng-leveling-framework.md`. Never invent or approximate level definitions.
- Cite specific interviewer feedback - don't generalize. "Alice noted X" not "interviewers felt X."
- Be direct about where signal is weak or missing. A gap in interview coverage is worth noting.
- If the candidate's target level doesn't match the interview signal, say so clearly.
- Do not include the candidate's phone number, email, or home address in the output.
- This assessment is for the user's internal use in hiring decisions. Treat all candidate data as confidential.
