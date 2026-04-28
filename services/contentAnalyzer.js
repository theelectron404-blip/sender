/**
 * Content Spam Analysis - Prevent Silent Drops
 * 
 * Analyzes email content for spam triggers before sending
 * Provides actionable suggestions to improve deliverability
 */

class ContentAnalyzer {
    constructor() {
        // Common spam trigger words/phrases
        this.spamTriggers = {
            high: [
                'buy now', 'click here', 'limited time', 'act now', 'urgent', 'congratulations',
                'you have won', 'free money', 'risk-free', 'no obligation', 'guarantee',
                'double your income', 'make money fast', 'work from home', 'be your own boss',
                'cash bonus', 'extra income', 'financial freedom', 'hidden charges',
                'increase sales', 'miracle', 'once in lifetime', 'satisfaction guaranteed'
            ],
            medium: [
                'free', 'discount', 'save money', 'lowest price', 'compare rates',
                'call now', 'dont delete', 'exclusive deal', 'expire', 'get started now',
                'important information', 'order now', 'special promotion', 'what are you waiting for',
                'winner', 'you are a winner', 'collect your prize', 'claim now'
            ],
            low: [
                'subscribe', 'unsubscribe', 'newsletter', 'update', 'promotion',
                'offer', 'deal', 'sale', 'bonus', 'reward', 'benefit', 'advantage',
                'opportunity', 'join', 'register', 'sign up', 'membership'
            ]
        };

        this.htmlSpamPatterns = [
            { pattern: /<font[^>]*color[^>]*>/gi, weight: 2, issue: 'Avoid <font> tags with colors' },
            { pattern: /background-color:\s*#?ff0000/gi, weight: 3, issue: 'Red background colors trigger spam filters' },
            { pattern: /style="[^"]*display:\s*none/gi, weight: 5, issue: 'Hidden content detected' },
            { pattern: /<img[^>]*width="1"[^>]*height="1"/gi, weight: 4, issue: 'Tracking pixels detected' },
            { pattern: /\$\$\$+/g, weight: 3, issue: 'Multiple dollar signs look spammy' },
            { pattern: /!{3,}/g, weight: 2, issue: 'Excessive exclamation marks' },
            { pattern: /[A-Z]{10,}/g, weight: 3, issue: 'Excessive capitalization' },
            { pattern: /<script/gi, weight: 10, issue: 'JavaScript is blocked by most email clients' }
        ];

        this.linkPatterns = [
            { pattern: /bit\.ly|tinyurl|t\.co/gi, weight: 3, issue: 'URL shorteners trigger spam filters' },
            { pattern: /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, weight: 4, issue: 'IP addresses instead of domains look suspicious' },
            { pattern: /https?:\/\/[^\/\s]+\/[a-zA-Z0-9]{20,}/gi, weight: 2, issue: 'Very long URLs may appear suspicious' }
        ];
    }

    // Analyze email content for spam likelihood
    analyzeContent(subject, htmlBody, textBody = '') {
        const results = {
            spamScore: 0,
            maxScore: 100,
            issues: [],
            suggestions: [],
            riskLevel: 'low',
            deliverabilityScore: 100
        };

        // Analyze subject line
        const subjectAnalysis = this.analyzeSubject(subject);
        results.spamScore += subjectAnalysis.score;
        results.issues.push(...subjectAnalysis.issues);
        results.suggestions.push(...subjectAnalysis.suggestions);

        // Analyze HTML content
        const htmlAnalysis = this.analyzeHTML(htmlBody);
        results.spamScore += htmlAnalysis.score;
        results.issues.push(...htmlAnalysis.issues);
        results.suggestions.push(...htmlAnalysis.suggestions);

        // Analyze text content
        const textAnalysis = this.analyzeText(htmlBody + ' ' + textBody);
        results.spamScore += textAnalysis.score;
        results.issues.push(...textAnalysis.issues);
        results.suggestions.push(...textAnalysis.suggestions);

        // Calculate final scores
        results.deliverabilityScore = Math.max(0, 100 - results.spamScore);
        
        if (results.spamScore >= 30) results.riskLevel = 'high';
        else if (results.spamScore >= 15) results.riskLevel = 'medium';
        else results.riskLevel = 'low';

        return results;
    }

    analyzeSubject(subject) {
        const analysis = { score: 0, issues: [], suggestions: [] };
        
        if (!subject || subject.trim().length === 0) {
            analysis.score += 10;
            analysis.issues.push('Empty subject line');
            analysis.suggestions.push('Add a descriptive subject line');
            return analysis;
        }

        // Length check
        if (subject.length > 50) {
            analysis.score += 3;
            analysis.issues.push('Subject line too long');
            analysis.suggestions.push('Keep subject under 50 characters for better mobile display');
        }

        // Spam word check
        for (const [severity, words] of Object.entries(this.spamTriggers)) {
            const weight = severity === 'high' ? 5 : severity === 'medium' ? 3 : 1;
            for (const word of words) {
                if (subject.toLowerCase().includes(word.toLowerCase())) {
                    analysis.score += weight;
                    analysis.issues.push(`Spam trigger word: "${word}"`);
                    analysis.suggestions.push(`Consider replacing "${word}" with less promotional language`);
                }
            }
        }

        // Excessive punctuation
        const exclamationCount = (subject.match(/!/g) || []).length;
        if (exclamationCount > 1) {
            analysis.score += exclamationCount * 2;
            analysis.issues.push('Too many exclamation marks');
            analysis.suggestions.push('Use only one exclamation mark, if any');
        }

        // All caps check
        if (subject === subject.toUpperCase() && subject.length > 5) {
            analysis.score += 8;
            analysis.issues.push('All caps subject line');
            analysis.suggestions.push('Use normal capitalization');
        }

        return analysis;
    }

    analyzeHTML(html) {
        const analysis = { score: 0, issues: [], suggestions: [] };
        
        if (!html) return analysis;

        // Check for HTML spam patterns
        for (const pattern of this.htmlSpamPatterns) {
            const matches = html.match(pattern.pattern);
            if (matches) {
                analysis.score += pattern.weight * matches.length;
                analysis.issues.push(pattern.issue);
                analysis.suggestions.push(`Fix: ${pattern.issue}`);
            }
        }

        // Check link patterns
        for (const pattern of this.linkPatterns) {
            const matches = html.match(pattern.pattern);
            if (matches) {
                analysis.score += pattern.weight * matches.length;
                analysis.issues.push(pattern.issue);
                analysis.suggestions.push(`Fix: ${pattern.issue}`);
            }
        }

        // Image to text ratio
        const imageCount = (html.match(/<img/gi) || []).length;
        const textLength = html.replace(/<[^>]*>/g, '').trim().length;
        
        if (imageCount > 3 && textLength < 100) {
            analysis.score += 5;
            analysis.issues.push('Too many images, not enough text');
            analysis.suggestions.push('Add more text content to balance images');
        }

        // Missing alt tags
        const imgTagsWithoutAlt = html.match(/<img(?![^>]*alt=)[^>]*>/gi);
        if (imgTagsWithoutAlt && imgTagsWithoutAlt.length > 0) {
            analysis.score += 2;
            analysis.issues.push('Images missing alt attributes');
            analysis.suggestions.push('Add alt text to all images for accessibility');
        }

        return analysis;
    }

    analyzeText(text) {
        const analysis = { score: 0, issues: [], suggestions: [] };
        
        if (!text) return analysis;

        const plainText = text.replace(/<[^>]*>/g, '').toLowerCase();

        // Spam word analysis
        for (const [severity, words] of Object.entries(this.spamTriggers)) {
            const weight = severity === 'high' ? 3 : severity === 'medium' ? 2 : 1;
            for (const word of words) {
                const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
                const matches = plainText.match(regex);
                if (matches) {
                    analysis.score += weight * matches.length;
                    analysis.issues.push(`Repeated spam trigger: "${word}" (${matches.length}x)`);
                    analysis.suggestions.push(`Reduce usage of "${word}"`);
                }
            }
        }

        // Excessive capitalization
        const words = plainText.split(/\s+/);
        const capsWords = words.filter(word => word.length > 2 && word === word.toUpperCase());
        if (capsWords.length > words.length * 0.1) {
            analysis.score += 4;
            analysis.issues.push('Too much capitalization');
            analysis.suggestions.push('Use normal case for most words');
        }

        return analysis;
    }

    // Get content improvement suggestions
    getSuggestions(analysisResults) {
        const suggestions = [...analysisResults.suggestions];
        
        if (analysisResults.riskLevel === 'high') {
            suggestions.unshift('🚨 High spam risk detected - consider significant content revision');
        } else if (analysisResults.riskLevel === 'medium') {
            suggestions.unshift('⚠️ Medium spam risk - address key issues before sending');
        }

        // Add general deliverability tips
        suggestions.push('💡 Use personalization to improve engagement');
        suggestions.push('📱 Test on mobile devices before sending');
        suggestions.push('✅ Include a clear unsubscribe link');
        suggestions.push('🎯 Segment your audience for better targeting');

        return [...new Set(suggestions)]; // Remove duplicates
    }

    // Quick content score for UI display
    getContentGrade(spamScore) {
        if (spamScore <= 5) return { grade: 'A', color: '#22c55e', description: 'Excellent' };
        if (spamScore <= 10) return { grade: 'B', color: '#3b82f6', description: 'Good' };
        if (spamScore <= 20) return { grade: 'C', color: '#f59e0b', description: 'Fair' };
        if (spamScore <= 30) return { grade: 'D', color: '#ef4444', description: 'Poor' };
        return { grade: 'F', color: '#991b1b', description: 'Very Poor' };
    }
}

module.exports = { ContentAnalyzer };