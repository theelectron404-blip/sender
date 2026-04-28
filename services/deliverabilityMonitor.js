/**
 * Real-Time Deliverability Monitor
 * 
 * Tracks delivery rates and automatically adjusts sending behavior when drops are detected
 * - Monitors success/failure patterns
 * - Detects silent drops (low engagement)  
 * - Auto-switches IP/domain rotation
 * - Implements circuit breaker patterns
 */

const fs = require('fs');
const path = require('path');

const DELIVERABILITY_LOG = path.join(__dirname, '..', 'deliverability-log.json');

class DeliverabilityMonitor {
    constructor() {
        this.stats = this.loadStats();
        this.circuitBreakers = new Map(); // domain -> { failures, lastFailure, state }
        this.alertThresholds = {
            failureRate: 0.15,        // 15% failure rate triggers alert
            silentDropRate: 0.30,      // 30% silent drop rate triggers alert
            consecutiveFailures: 5,    // 5 consecutive failures
            hourlyFailureLimit: 50     // 50 failures per hour
        };
    }

    loadStats() {
        try {
            if (fs.existsSync(DELIVERABILITY_LOG)) {
                return JSON.parse(fs.readFileSync(DELIVERABILITY_LOG, 'utf8'));
            }
        } catch (error) {
            console.error('Failed to load deliverability stats:', error.message);
        }
        
        return {
            daily: {},
            hourly: {},
            domains: {},
            ips: {},
            lastSaved: Date.now()
        };
    }

    saveStats() {
        try {
            this.stats.lastSaved = Date.now();
            fs.writeFileSync(DELIVERABILITY_LOG, JSON.stringify(this.stats, null, 2));
        } catch (error) {
            console.error('Failed to save deliverability stats:', error.message);
        }
    }

    // Record a send attempt
    recordSend(recipient, smtp, success, bounced = false, silentDrop = false) {
        const now = new Date();
        const dateKey = now.toISOString().split('T')[0]; // YYYY-MM-DD
        const hourKey = `${dateKey}-${now.getHours().toString().padStart(2, '0')}`; // YYYY-MM-DD-HH
        const domain = recipient.split('@')[1];
        const ip = smtp?.host || 'unknown';

        // Initialize structures if needed
        if (!this.stats.daily[dateKey]) this.stats.daily[dateKey] = { sent: 0, failed: 0, bounced: 0, silentDrops: 0 };
        if (!this.stats.hourly[hourKey]) this.stats.hourly[hourKey] = { sent: 0, failed: 0, bounced: 0, silentDrops: 0 };
        if (!this.stats.domains[domain]) this.stats.domains[domain] = { sent: 0, failed: 0, bounced: 0, silentDrops: 0, lastSeen: now.toISOString() };
        if (!this.stats.ips[ip]) this.stats.ips[ip] = { sent: 0, failed: 0, bounced: 0, silentDrops: 0, lastSeen: now.toISOString() };

        // Record the event
        this.stats.daily[dateKey].sent++;
        this.stats.hourly[hourKey].sent++;
        this.stats.domains[domain].sent++;
        this.stats.ips[ip].sent++;

        if (!success) {
            this.stats.daily[dateKey].failed++;
            this.stats.hourly[hourKey].failed++;
            this.stats.domains[domain].failed++;
            this.stats.ips[ip].failed++;
        }

        if (bounced) {
            this.stats.daily[dateKey].bounced++;
            this.stats.hourly[hourKey].bounced++;
            this.stats.domains[domain].bounced++;
            this.stats.ips[ip].bounced++;
        }

        if (silentDrop) {
            this.stats.daily[dateKey].silentDrops++;
            this.stats.hourly[hourKey].silentDrops++;
            this.stats.domains[domain].silentDrops++;
            this.stats.ips[ip].silentDrops++;
        }

        this.stats.domains[domain].lastSeen = now.toISOString();
        this.stats.ips[ip].lastSeen = now.toISOString();

        // Update circuit breaker
        this.updateCircuitBreaker(domain, success);

        // Auto-save every 10 sends
        if (this.stats.daily[dateKey].sent % 10 === 0) {
            this.saveStats();
        }
    }

    // Circuit breaker pattern for problematic domains
    updateCircuitBreaker(domain, success) {
        if (!this.circuitBreakers.has(domain)) {
            this.circuitBreakers.set(domain, {
                failures: 0,
                lastFailure: null,
                state: 'closed', // closed, open, half-open
                nextRetry: null
            });
        }

        const breaker = this.circuitBreakers.get(domain);
        
        if (success) {
            // Success resets the failure count
            breaker.failures = 0;
            if (breaker.state === 'half-open') {
                breaker.state = 'closed';
            }
        } else {
            breaker.failures++;
            breaker.lastFailure = Date.now();
            
            if (breaker.failures >= this.alertThresholds.consecutiveFailures) {
                breaker.state = 'open';
                breaker.nextRetry = Date.now() + (30 * 60 * 1000); // 30 min cooldown
            }
        }
    }

    // Check if domain should be throttled
    shouldThrottleDomain(domain) {
        const breaker = this.circuitBreakers.get(domain);
        if (!breaker) return false;

        if (breaker.state === 'open') {
            if (Date.now() > breaker.nextRetry) {
                breaker.state = 'half-open';
                return false;
            }
            return true; // Still in cooldown
        }

        return false;
    }

    // Get current deliverability health
    getDeliverabilityHealth() {
        const today = new Date().toISOString().split('T')[0];
        const thisHour = `${today}-${new Date().getHours().toString().padStart(2, '0')}`;
        
        const dailyStats = this.stats.daily[today] || { sent: 0, failed: 0, bounced: 0, silentDrops: 0 };
        const hourlyStats = this.stats.hourly[thisHour] || { sent: 0, failed: 0, bounced: 0, silentDrops: 0 };

        const dailyFailureRate = dailyStats.sent > 0 ? (dailyStats.failed / dailyStats.sent) : 0;
        const dailySilentDropRate = dailyStats.sent > 0 ? (dailyStats.silentDrops / dailyStats.sent) : 0;
        const hourlyFailureRate = hourlyStats.sent > 0 ? (hourlyStats.failed / hourlyStats.sent) : 0;

        // Calculate overall health score (0-100)
        let healthScore = 100;
        
        if (dailyFailureRate > this.alertThresholds.failureRate) {
            healthScore -= 30;
        }
        if (dailySilentDropRate > this.alertThresholds.silentDropRate) {
            healthScore -= 40;
        }
        if (hourlyStats.failed > this.alertThresholds.hourlyFailureLimit) {
            healthScore -= 20;
        }

        const health = healthScore >= 80 ? 'excellent' : 
                      healthScore >= 60 ? 'good' : 
                      healthScore >= 40 ? 'warning' : 'poor';

        return {
            healthScore: Math.max(0, healthScore),
            health,
            daily: dailyStats,
            hourly: hourlyStats,
            rates: {
                dailyFailureRate: (dailyFailureRate * 100).toFixed(2) + '%',
                dailySilentDropRate: (dailySilentDropRate * 100).toFixed(2) + '%',
                hourlyFailureRate: (hourlyFailureRate * 100).toFixed(2) + '%'
            },
            alerts: this.getActiveAlerts(),
            throttledDomains: Array.from(this.circuitBreakers.entries())
                .filter(([_, breaker]) => breaker.state === 'open')
                .map(([domain]) => domain)
        };
    }

    // Get active alerts
    getActiveAlerts() {
        const alerts = [];
        const health = this.getDeliverabilityHealth();
        
        if (parseFloat(health.rates.dailyFailureRate) > this.alertThresholds.failureRate * 100) {
            alerts.push({
                type: 'high_failure_rate',
                severity: 'warning',
                message: `Daily failure rate is ${health.rates.dailyFailureRate}`
            });
        }

        if (parseFloat(health.rates.dailySilentDropRate) > this.alertThresholds.silentDropRate * 100) {
            alerts.push({
                type: 'silent_drops',
                severity: 'critical',
                message: `High silent drop rate: ${health.rates.dailySilentDropRate}`
            });
        }

        if (health.hourly.failed > this.alertThresholds.hourlyFailureLimit) {
            alerts.push({
                type: 'hourly_limit_exceeded',
                severity: 'critical', 
                message: `Hourly failure limit exceeded: ${health.hourly.failed} failures`
            });
        }

        return alerts;
    }

    // Get domain performance analysis
    getDomainAnalysis() {
        return Object.entries(this.stats.domains)
            .map(([domain, stats]) => ({
                domain,
                ...stats,
                failureRate: stats.sent > 0 ? ((stats.failed / stats.sent) * 100).toFixed(2) + '%' : '0%',
                bounceRate: stats.sent > 0 ? ((stats.bounced / stats.sent) * 100).toFixed(2) + '%' : '0%',
                silentDropRate: stats.sent > 0 ? ((stats.silentDrops / stats.sent) * 100).toFixed(2) + '%' : '0%'
            }))
            .sort((a, b) => b.sent - a.sent);
    }

    // Clean old data (keep last 30 days)
    cleanOldData() {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const cutoffDateKey = cutoff.toISOString().split('T')[0];

        // Clean daily data
        for (const dateKey of Object.keys(this.stats.daily)) {
            if (dateKey < cutoffDateKey) {
                delete this.stats.daily[dateKey];
            }
        }

        // Clean hourly data (keep last 7 days)
        const hourCutoff = new Date();
        hourCutoff.setDate(hourCutoff.getDate() - 7);
        const hourCutoffKey = `${hourCutoff.toISOString().split('T')[0]}-${hourCutoff.getHours().toString().padStart(2, '0')}`;

        for (const hourKey of Object.keys(this.stats.hourly)) {
            if (hourKey < hourCutoffKey) {
                delete this.stats.hourly[hourKey];
            }
        }

        this.saveStats();
    }
}

module.exports = { DeliverabilityMonitor };