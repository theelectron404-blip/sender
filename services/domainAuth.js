/**
 * Domain Authentication Monitor
 * 
 * Checks SPF, DKIM, and DMARC records for your sending domains
 * Alerts when authentication is misconfigured (major drop cause)
 */

const dns = require('dns').promises;

// Setup custom DNS resolver to avoid system DNS issues
const resolver = new dns.Resolver();
resolver.setServers(['8.8.8.8', '1.1.1.1']);

async function checkSPF(domain) {
    try {
        const records = await resolver.resolveTxt(domain);
        const spfRecord = records.find(r => r.join('').startsWith('v=spf1'));
        
        if (!spfRecord) {
            return { status: 'missing', issue: 'No SPF record found' };
        }
        
        const spf = spfRecord.join('');
        
        // Common SPF issues
        if (!spf.includes('~all') && !spf.includes('-all')) {
            return { status: 'warning', issue: 'SPF record should end with ~all or -all' };
        }
        
        if (spf.split(' ').length > 10) {
            return { status: 'error', issue: 'SPF record has too many mechanisms (DNS lookup limit)' };
        }
        
        return { status: 'ok', record: spf };
    } catch (error) {
        return { status: 'error', issue: error.message };
    }
}

async function checkDKIM(domain, selector = 'default') {
    try {
        const dkimDomain = `${selector}._domainkey.${domain}`;
        const records = await resolver.resolveTxt(dkimDomain);
        const dkimRecord = records.find(r => r.join('').includes('v=DKIM1'));
        
        if (!dkimRecord) {
            return { status: 'missing', issue: `No DKIM record found for selector '${selector}'` };
        }
        
        const dkim = dkimRecord.join('');
        
        if (!dkim.includes('p=')) {
            return { status: 'error', issue: 'DKIM record missing public key' };
        }
        
        return { status: 'ok', record: dkim, selector };
    } catch (error) {
        return { status: 'missing', issue: `DKIM selector '${selector}' not found` };
    }
}

async function checkDMARC(domain) {
    try {
        const dmarcDomain = `_dmarc.${domain}`;
        const records = await resolver.resolveTxt(dmarcDomain);
        const dmarcRecord = records.find(r => r.join('').startsWith('v=DMARC1'));
        
        if (!dmarcRecord) {
            return { status: 'missing', issue: 'No DMARC record found' };
        }
        
        const dmarc = dmarcRecord.join('');
        
        // Check DMARC policy
        if (!dmarc.includes('p=')) {
            return { status: 'error', issue: 'DMARC record missing policy' };
        }
        
        const policy = dmarc.match(/p=([^;]+)/)?.[1];
        if (policy === 'none') {
            return { status: 'warning', issue: 'DMARC policy is set to "none" - consider "quarantine" or "reject"' };
        }
        
        return { status: 'ok', record: dmarc, policy };
    } catch (error) {
        return { status: 'error', issue: error.message };
    }
}

async function checkDomainAuth(domain) {
    console.log(`🔍 Checking authentication for ${domain}...`);
    
    const results = {
        domain,
        timestamp: new Date().toISOString(),
        spf: await checkSPF(domain),
        dkim: await checkDKIM(domain),
        dmarc: await checkDMARC(domain)
    };
    
    // Overall health score
    const scores = Object.values(results).filter(r => r.status).map(r => {
        switch(r.status) {
            case 'ok': return 100;
            case 'warning': return 70;
            case 'missing': return 30;
            case 'error': return 0;
            default: return 0;
        }
    });
    
    results.healthScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    results.overall = results.healthScore >= 80 ? 'good' : results.healthScore >= 60 ? 'warning' : 'poor';
    
    return results;
}

module.exports = { checkDomainAuth, checkSPF, checkDKIM, checkDMARC };