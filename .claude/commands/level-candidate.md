# Level Candidate

Assess an engineering candidate against your IC leveling framework. Produces a structured leveling recommendation.

## Arguments

The argument string is: $ARGUMENTS

Parse as: a candidate name, optionally followed by a PDF path or other context. If no arguments, ask for the candidate name and any available materials (resume, interview feedback PDF, link).

## Steps

1. **Gather materials**: Read any provided PDFs, resumes, or links. If a feedback PDF is provided, read all pages. If only a name is given, search available integrations for interview feedback or records.

2. **Read the leveling framework**: Read `data/files/areas/career/eng-leveling-framework.md` for the full IC competency framework. This is the source of truth — do not paraphrase or approximate the level definitions. If this file doesn't exist, ask the user to provide or create their leveling framework first.

3. **Identify the target level range**: Based on the candidate's experience and the role they're interviewing for, identify 2-3 adjacent levels to evaluate against (e.g., L3/L4 or L4/L5).

4. **Map interview signal to framework dimensions**: For each framework dimension, quote the specific competency language from the framework and cite specific interview evidence for or against. Use this format:

   ```
   ### [Dimension Name]

   **[Level] expectation**: "[exact framework language]"
   **Evidence**: [specific interview signal with interviewer name and round]
   **Assessment**: Meets / Exceeds / Below

   **[Next Level] expectation**: "[exact framework language]"
   **Evidence**: [specific interview signal]
   **Assessment**: Meets / Exceeds / Below
   ```

5. **Summarize the scorecard**: Present the overall interview panel results (interviewer, round, rating, key quote).

6. **Make a leveling recommendation**: Based on the framework mapping, recommend a level. Call out:
   - Which dimensions are strongest / weakest
   - Any gaps that are typical-for-level vs. concerning
   - How the debrief consensus (if available) aligns with your framework analysis
   - Comp/timeline context if available from recruiter screen

7. **Flag risks and development areas**: Note anything the hiring manager should watch for in the first 6 months, based on interview signal gaps.

## Rules

- Always use the actual framework language from `data/files/areas/career/eng-leveling-framework.md`. Never invent or approximate level definitions.
- Cite specific interviewer feedback — don't generalize. "Alex noted X" not "interviewers felt X."
- Be direct about where signal is weak or missing. A gap in interview coverage is worth noting.
- If the candidate's target level doesn't match the interview signal, say so clearly.
- Do not include the candidate's phone number, email, or home address in the output.
- This assessment is for internal use in hiring decisions. Treat all candidate data as confidential.
