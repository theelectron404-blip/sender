function renderApacheSoft404Html() {
    return [
        '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">',
        '<html><head>',
        '<title>404 Not Found</title>',
        '</head><body>',
        '<h1>Not Found</h1>',
        '<p>The requested URL was not found on this server.</p>',
        '<hr>',
        '<address>Apache/2.4.58 (Unix) Server at localhost Port 80</address>',
        '</body></html>',
    ].join('\n');
}

function createSecurityObscurityMiddleware(options) {
    const opts = options || {};
    const validateSession = typeof opts.validateSession === 'function' ? opts.validateSession : () => false;
    const validateReferrer = typeof opts.validateReferrer === 'function' ? opts.validateReferrer : () => false;
    const html = opts.html || renderApacheSoft404Html();

    return function securityObscurityMiddleware(req, res, next) {
        const hasValidSession = !!validateSession(req);
        const hasValidReferrer = !!validateReferrer(req);
        if (hasValidSession && hasValidReferrer) return next();

        res.status(200);
        res.setHeader('Content-Type', 'text/html; charset=UTF-8');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.send(html);
    };
}

module.exports = {
    renderApacheSoft404Html,
    createSecurityObscurityMiddleware,
};
