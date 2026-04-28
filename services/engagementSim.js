/**
 * Engagement Simulator - Reputation Booster
 * 
 * Simulates human-like email interactions to boost sender reputation:
 * - Marks random emails as read
 * - Moves emails between folders 
 * - Adds/removes flags
 * - Simulates inbox organization patterns
 * 
 * This convinces Gmail/Outlook that your sending accounts are actively used
 */

const { ImapFlow } = require('imapflow');

class EngagementSimulator {
    constructor(imapAccount) {
        this.account = imapAccount;
        this.client = null;
        this.humanPatterns = [
            'markAsRead',
            'moveToFolder', 
            'addFlag',
            'removeFlag',
            'searchAndOrganize'
        ];
    }

    async connect() {
        this.client = new ImapFlow({
            host: this.account.host,
            port: parseInt(this.account.port, 10) || 993,
            secure: this.account.secure !== false,
            auth: { user: this.account.user, pass: this.account.pass },
            logger: false
        });
        await this.client.connect();
    }

    async disconnect() {
        if (this.client) {
            await this.client.logout();
            this.client = null;
        }
    }

    // Simulate reading 3-7 random emails
    async markAsRead() {
        try {
            const lock = await this.client.getMailboxLock('INBOX');
            const messages = await this.client.search({ seen: false }, { uid: true });
            
            if (messages.length === 0) return 0;
            
            // Read 3-7 random emails (human-like behavior)
            const toRead = Math.min(messages.length, 3 + Math.floor(Math.random() * 5));
            const selectedMsgs = this.shuffleArray(messages).slice(0, toRead);
            
            for (const uid of selectedMsgs) {
                await this.client.messageFlagsAdd(uid.toString(), ['\\Seen'], { uid: true });
                // Human-like delay between actions
                await this.randomDelay(500, 2000);
            }
            
            lock.release();
            return selectedMsgs.length;
        } catch (error) {
            console.error('Engagement simulation error:', error.message);
            return 0;
        }
    }

    // Move emails to different folders (if they exist)
    async moveToFolder() {
        try {
            const folders = ['Sent', 'Drafts', 'Archive', 'Important'];
            const lock = await this.client.getMailboxLock('INBOX');
            const messages = await this.client.search({}, { uid: true });
            
            if (messages.length < 5) {
                lock.release();
                return 0;
            }
            
            // Move 1-2 random emails
            const toMove = Math.min(2, Math.ceil(Math.random() * 2));
            const selectedMsgs = this.shuffleArray(messages).slice(0, toMove);
            const targetFolder = folders[Math.floor(Math.random() * folders.length)];
            
            let moved = 0;
            for (const uid of selectedMsgs) {
                try {
                    await this.client.messageMove(uid.toString(), targetFolder, { uid: true });
                    moved++;
                    await this.randomDelay(300, 1500);
                } catch (e) {
                    // Folder might not exist, skip
                }
            }
            
            lock.release();
            return moved;
        } catch (error) {
            return 0;
        }
    }

    // Add importance/priority flags
    async addFlag() {
        try {
            const lock = await this.client.getMailboxLock('INBOX');
            const messages = await this.client.search({}, { uid: true });
            
            if (messages.length === 0) {
                lock.release();
                return 0;
            }
            
            const flags = ['\\Flagged', '\\Important'];
            const selectedMsg = messages[Math.floor(Math.random() * messages.length)];
            const flag = flags[Math.floor(Math.random() * flags.length)];
            
            await this.client.messageFlagsAdd(selectedMsg.toString(), [flag], { uid: true });
            lock.release();
            return 1;
        } catch (error) {
            return 0;
        }
    }

    // Simulate inbox organization (search and bulk actions)
    async searchAndOrganize() {
        try {
            const lock = await this.client.getMailboxLock('INBOX');
            
            // Search for old emails and mark them as read
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - 7); // 7 days ago
            
            const oldMessages = await this.client.search({ 
                before: cutoffDate,
                seen: false 
            }, { uid: true });
            
            let organized = 0;
            for (const uid of oldMessages.slice(0, 10)) { // Limit to 10
                await this.client.messageFlagsAdd(uid.toString(), ['\\Seen'], { uid: true });
                organized++;
                await this.randomDelay(100, 500);
            }
            
            lock.release();
            return organized;
        } catch (error) {
            return 0;
        }
    }

    // Run a random engagement pattern
    async simulateActivity() {
        if (!this.client) return { actions: 0, pattern: 'none' };
        
        const pattern = this.humanPatterns[Math.floor(Math.random() * this.humanPatterns.length)];
        let actions = 0;
        
        switch (pattern) {
            case 'markAsRead':
                actions = await this.markAsRead();
                break;
            case 'moveToFolder':
                actions = await this.moveToFolder();
                break;
            case 'addFlag':
                actions = await this.addFlag();
                break;
            case 'searchAndOrganize':
                actions = await this.searchAndOrganize();
                break;
        }
        
        return { actions, pattern };
    }

    // Utility methods
    shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    async randomDelay(min, max) {
        const delay = min + Math.random() * (max - min);
        return new Promise(resolve => setTimeout(resolve, delay));
    }
}

// Run engagement simulation across all IMAP accounts
async function runEngagementSimulation(imapAccounts, io) {
    let totalActions = 0;
    const results = [];
    
    for (const account of imapAccounts) {
        const sim = new EngagementSimulator(account);
        
        try {
            await sim.connect();
            const result = await sim.simulateActivity();
            await sim.disconnect();
            
            totalActions += result.actions;
            results.push({
                account: account.user,
                ...result
            });
            
            if (io && result.actions > 0) {
                io.emit('engagement:activity', {
                    account: account.user,
                    actions: result.actions,
                    pattern: result.pattern,
                    timestamp: Date.now()
                });
            }
        } catch (error) {
            console.error(`Engagement simulation failed for ${account.user}:`, error.message);
        }
    }
    
    return { totalActions, results };
}

module.exports = { EngagementSimulator, runEngagementSimulation };