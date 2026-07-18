import { Frame, ElementHandle } from 'playwright';
import { SecurityQuestionMap, SECURITY_QUESTION_SLOTS } from '../types/index.js';
import { normalizeText } from '../../../shared/utils/text.js';

/**
 * Result of handling security questions
 */
export interface SecurityQuestionsResult {
  /** Whether all visible questions were answered */
  allAnswered: boolean;
  /** Minimum number of answers required to proceed (Banesco typically requires 2) */
  minimumRequiredAnswers: number;
  /** Whether we met the minimum number of answers required to proceed */
  meetsMinimum: boolean;
  /** Number of visible questions detected */
  questionsFound: number;
  /** Number of questions successfully answered */
  answersProvided: number;
  /** Details about each question for debugging */
  details: Array<{
    labelId: string;
    questionText: string;
    status: 'answered' | 'no_keyword_match' | 'input_not_found' | 'input_not_accessible';
  }>;
}

export class SecurityQuestionsHandler {
  private questionMap: SecurityQuestionMap;
  private readonly debug: boolean;
  private static readonly MIN_REQUIRED_ANSWERS = 2;

  constructor(securityQuestionsConfig: string, debug = false) {
    this.debug = debug;
    this.questionMap = this.parseSecurityQuestions(securityQuestionsConfig);
  }

  /** Debug-gated logger — silent unless the connector was created with `debug: true`. */
  private log(message: string): void {
    if (this.debug) {
      console.log(message);
    }
  }

  private parseSecurityQuestions(securityQuestions: string): SecurityQuestionMap {
    const questionMap: SecurityQuestionMap = {};
    
    if (!securityQuestions) {
      this.log('[SecurityQuestions] No security questions configuration found');
      return questionMap;
    }
    
    const pairs = securityQuestions.split(',');
    
    for (const pair of pairs) {
      const [keyword, answer] = pair.split(':');
      if (keyword && answer) {
        const normalizedKeyword = normalizeText(keyword);

        questionMap[normalizedKeyword] = answer.trim();
        this.log(`[SecurityQuestions] Mapped keyword: "${keyword.trim()}" -> answer configured`);
      }
    }
    
    return questionMap;
  }


  private findMatchingAnswer(questionText: string): { answer: string | null; matchedKeyword: string | null } {
    const normalizedQuestion = normalizeText(questionText);
    
    for (const [keyword, answer] of Object.entries(this.questionMap)) {
      if (normalizedQuestion.includes(keyword)) {
        this.log(`[SecurityQuestions] Match found: keyword="${keyword}"`);
        return { answer, matchedKeyword: keyword };
      }
    }
    
    // Log the FULL question text so user can configure the right keyword
    const keywords = Object.keys(this.questionMap);
    this.log(`[SecurityQuestions] NO MATCH for question:`);
    this.log(`[SecurityQuestions]    FULL TEXT: "${questionText.trim()}"`);
    this.log(`[SecurityQuestions]    NORMALIZED: "${normalizedQuestion}"`);
    this.log(`[SecurityQuestions]    Your keywords: [${keywords.join(', ')}]`);
    this.log(`[SecurityQuestions]    Add a keyword from this question to BANESCO_SECURITY_QUESTIONS`);
    
    return { answer: null, matchedKeyword: null };
  }

  /**
   * Build multiple selector patterns for ASP.NET elements that may have prefixes
   * Example: for 'lblPrimeraP' returns selectors like:
   *   #lblPrimeraP, [id$="lblPrimeraP"], [id*="_lblPrimeraP"], #ctl00_cp_lblPrimeraP, etc.
   */
  private buildRobustSelectors(baseId: string): string[] {
    return [
      `#${baseId}`,                           // Exact match
      `[id$="${baseId}"]`,                    // Ends with (e.g. ctl00_cp_lblPrimeraP)
      `[id*="_${baseId}"]`,                   // Contains with underscore prefix
      `#ctl00_cp_${baseId}`,                  // Common ASP.NET prefix
      `#ctl00_cp_ddpControles_${baseId}`,     // Another common pattern
      `[name$="${baseId}"]`,                  // By name attribute ending
    ];
  }

  /**
   * Find an element using robust selectors (handles ASP.NET ID prefixes)
   */
  private async findElementRobust(frame: Frame, baseId: string): Promise<ElementHandle | null> {
    const selectors = this.buildRobustSelectors(baseId);
    
    for (const selector of selectors) {
      try {
        const element = await frame.$(selector);
        if (element) {
          return element;
        }
      } catch {
        // Continue to next selector
      }
    }
    
    return null;
  }

  /**
   * Handle security questions in the Banesco login flow.
   * Returns detailed result including whether ALL visible questions were answered.
   */
  async handleSecurityQuestions(frame: Frame): Promise<SecurityQuestionsResult> {
    this.log('[SecurityQuestions] Handling security questions...');
    
    const result: SecurityQuestionsResult = {
      allAnswered: false,
      minimumRequiredAnswers: SecurityQuestionsHandler.MIN_REQUIRED_ANSWERS,
      meetsMinimum: false,
      questionsFound: 0,
      answersProvided: 0,
      details: []
    };
    
    if (Object.keys(this.questionMap).length === 0) {
      this.log('[SecurityQuestions] ERROR: No question-answer mappings configured');
      return result;
    }
    
    this.log(`[SecurityQuestions] ${Object.keys(this.questionMap).length} keyword mappings loaded`);
    
    // Strategy 1: Try known Banesco element IDs with robust selectors
    const knownResult = await this.tryKnownElementsRobust(frame);
    result.questionsFound = knownResult.questionsFound;
    result.answersProvided = knownResult.answersProvided;
    result.details = knownResult.details;
    
    // Strategy 2: Fallback scan if no questions found via known elements
    if (result.questionsFound === 0) {
      this.log('[SecurityQuestions] Known elements not found, trying fallback scan...');
      const fallbackResult = await this.tryFallbackScan(frame, new Set());
      result.questionsFound = fallbackResult.questionsFound;
      result.answersProvided = fallbackResult.answersProvided;
      result.details = fallbackResult.details;
    }
    
    // Determine if all questions were answered and whether we met minimum required
    result.allAnswered = result.questionsFound > 0 && result.answersProvided === result.questionsFound;
    result.meetsMinimum = result.answersProvided >= SecurityQuestionsHandler.MIN_REQUIRED_ANSWERS;
    
    this.log(
      `[SecurityQuestions] Result: ${result.answersProvided}/${result.questionsFound} questions answered ` +
      `(minRequired=${SecurityQuestionsHandler.MIN_REQUIRED_ANSWERS})`
    );
    
    if (!result.allAnswered && result.questionsFound > 0) {
      // Log details about what failed
      for (const detail of result.details) {
        if (detail.status !== 'answered') {
          this.log(`[SecurityQuestions] FAILED: ${detail.labelId} - ${detail.status} - "${detail.questionText.substring(0, 40)}..."`);
        }
      }
    }
    
    return result;
  }

  /**
   * Try known Banesco element ID patterns with robust ASP.NET-safe selectors
   */
  private async tryKnownElementsRobust(frame: Frame): Promise<{
    questionsFound: number;
    answersProvided: number;
    details: SecurityQuestionsResult['details'];
  }> {
    const questionElements = SECURITY_QUESTION_SLOTS;
    
    let questionsFound = 0;
    let answersProvided = 0;
    const details: SecurityQuestionsResult['details'] = [];
    
    for (const element of questionElements) {
      try {
        // Find the question label using robust selectors
        const labelElement = await this.findElementRobust(frame, element.labelId);
        if (!labelElement) {
          // Label not found - this question slot is not present
          continue;
        }
        
        // Check if label is visible
        const labelVisible = await labelElement.isVisible().catch(() => false);
        if (!labelVisible) {
          continue;
        }
        
        // Get the question text
        const questionText = await labelElement.textContent();
        if (!questionText || questionText.trim().length < 5) {
          this.log(`[SecurityQuestions] Label ${element.labelId} found but empty or too short`);
          continue;
        }
        
        // This is a visible question - count it
        questionsFound++;
        this.log(`[SecurityQuestions] Found question #${questionsFound} (${element.labelId}): "${questionText.substring(0, 60)}..."`);
        
        // Look for an answer for this question
        const { answer, matchedKeyword } = this.findMatchingAnswer(questionText);
        
        if (!answer) {
          details.push({
            labelId: element.labelId,
            questionText: questionText.trim(),
            status: 'no_keyword_match'
          });
          continue;
        }
        
        // Find the input field using robust selectors
        const inputElement = await this.findElementRobust(frame, element.inputId);
        if (!inputElement) {
          this.log(`[SecurityQuestions] Input ${element.inputId} not found (tried robust selectors)`);
          details.push({
            labelId: element.labelId,
            questionText: questionText.trim(),
            status: 'input_not_found'
          });
          continue;
        }
        
        // Check if the field is visible and enabled
        const isVisible = await inputElement.isVisible().catch(() => false);
        const isEnabled = await inputElement.isEnabled().catch(() => false);
        
        if (!isVisible || !isEnabled) {
          this.log(`[SecurityQuestions] Input ${element.inputId} not accessible (visible=${isVisible}, enabled=${isEnabled})`);
          details.push({
            labelId: element.labelId,
            questionText: questionText.trim(),
            status: 'input_not_accessible'
          });
          continue;
        }
        
        // Fill the field
        try {
          this.log(`[SecurityQuestions] Filling ${element.inputId} with answer for keyword "${matchedKeyword}"`);
          await inputElement.click();
          await inputElement.fill(answer);
          await frame.waitForTimeout(300);
          answersProvided++;
          this.log(`[SecurityQuestions] Successfully filled ${element.inputId}`);
          details.push({
            labelId: element.labelId,
            questionText: questionText.trim(),
            status: 'answered'
          });
          
        } catch (e) {
          this.log(`[SecurityQuestions] ERROR filling ${element.inputId}: ${e}`);
          details.push({
            labelId: element.labelId,
            questionText: questionText.trim(),
            status: 'input_not_accessible'
          });
        }
        
      } catch (e) {
        this.log(`[SecurityQuestions] Error processing ${element.labelId}: ${e}`);
      }
    }
    
    return { questionsFound, answersProvided, details };
  }

  /**
   * Fallback: Scan page for labels/spans containing security question text
   * @param filledInputs Set of input element IDs already filled (to avoid duplicates)
   */
  private async tryFallbackScan(frame: Frame, filledInputs: Set<string>): Promise<{
    questionsFound: number;
    answersProvided: number;
    details: SecurityQuestionsResult['details'];
  }> {
    let questionsFound = 0;
    let answersProvided = 0;
    const details: SecurityQuestionsResult['details'] = [];
    
    try {
      // Find all labels, spans, or divs that might contain question text
      const potentialLabels = await frame.$$('label, span, div, td');
      this.log(`[SecurityQuestions] Fallback: Scanning ${potentialLabels.length} elements for questions`);
      
      for (const labelEl of potentialLabels) {
        try {
          const text = await labelEl.textContent();
          if (!text || text.length < 10 || text.length > 200) continue;
          
          // Check if this looks like a security question
          const normalizedText = normalizeText(text);
          const looksLikeQuestion = normalizedText.includes('pregunta') || 
                                    normalizedText.includes('cual') ||
                                    normalizedText.includes('nombre') ||
                                    normalizedText.includes('mascota') ||
                                    normalizedText.includes('favorito') ||
                                    normalizedText.includes('primer') ||
                                    normalizedText.includes('madre') ||
                                    normalizedText.includes('padre');
          
          if (!looksLikeQuestion) continue;
          
          // Check if visible
          const isVisible = await labelEl.isVisible().catch(() => false);
          if (!isVisible) continue;
          
          questionsFound++;
          const labelId = `fallback_${questionsFound}`;
          this.log(`[SecurityQuestions] Fallback: Found question #${questionsFound}: "${text.substring(0, 50)}..."`);
          
          // Try to find an answer
          const { answer, matchedKeyword } = this.findMatchingAnswer(text);
          if (!answer) {
            details.push({
              labelId,
              questionText: text.trim(),
              status: 'no_keyword_match'
            });
            continue;
          }
          
          // Try to find a nearby input field
          let inputEl = null;
          let inputId = '';
          
          // Strategy: look for input siblings, children, or use for attribute
          const forAttr = await labelEl.getAttribute('for');
          if (forAttr) {
            inputEl = await frame.$(`#${forAttr}`);
            inputId = forAttr;
          }
          
          if (!inputEl) {
            // Try to find input in parent or next sibling
            const parent = await labelEl.$('xpath=..');
            if (parent) {
              inputEl = await parent.$('input[type="text"], input:not([type="hidden"]):not([type="submit"])');
              if (inputEl) {
                inputId = await inputEl.getAttribute('id') || 'parent_input';
              }
            }
          }
          
          if (!inputEl) {
            // Try next sibling element
            inputEl = await labelEl.$('xpath=following-sibling::input[1]');
            if (inputEl) {
              inputId = await inputEl.getAttribute('id') || 'sibling_input';
            }
          }
          
          if (!inputEl) {
            // Try any input in the same row/container
            inputEl = await labelEl.$('xpath=ancestor::tr//input[not(@type="hidden")]');
            if (inputEl) {
              inputId = await inputEl.getAttribute('id') || 'row_input';
            }
          }
          
          if (!inputEl) {
            this.log(`[SecurityQuestions] Fallback: No input found near question`);
            details.push({
              labelId,
              questionText: text.trim(),
              status: 'input_not_found'
            });
            continue;
          }
          
          // Skip if we already filled this input
          if (filledInputs.has(inputId)) {
            this.log(`[SecurityQuestions] Fallback: Input ${inputId} already filled, skipping`);
            continue;
          }
          
          const inputVisible = await inputEl.isVisible().catch(() => false);
          const inputEnabled = await inputEl.isEnabled().catch(() => false);
          
          if (!inputVisible || !inputEnabled) {
            details.push({
              labelId,
              questionText: text.trim(),
              status: 'input_not_accessible'
            });
            continue;
          }
          
          try {
            this.log(`[SecurityQuestions] Fallback: Filling input for keyword "${matchedKeyword}"`);
            await inputEl.click();
            await inputEl.fill(answer);
            await frame.waitForTimeout(300);
            answersProvided++;
            filledInputs.add(inputId);
            this.log(`[SecurityQuestions] Fallback: Successfully filled input`);
            details.push({
              labelId,
              questionText: text.trim(),
              status: 'answered'
            });
          } catch (e) {
            this.log(`[SecurityQuestions] Fallback: ERROR filling input: ${e}`);
            details.push({
              labelId,
              questionText: text.trim(),
              status: 'input_not_accessible'
            });
          }
        } catch {
          // Continue scanning
        }
      }
    } catch (e) {
      this.log(`[SecurityQuestions] Fallback scan error: ${e}`);
    }
    
    return { questionsFound, answersProvided, details };
  }
}
