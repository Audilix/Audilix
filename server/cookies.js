/* ── Audilix Cookie Banner ── */
(function() {
    if (localStorage.getItem('audilix_cookies_accepted')) return;

    const style = document.createElement('style');
    style.textContent = `
        #audilix-cookie-banner {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            z-index: 99999;
            background: #0B2545;
            border-top: 2px solid #C9A84C;
            padding: 20px 40px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 24px;
            font-family: 'DM Sans', sans-serif;
            box-shadow: 0 -8px 32px rgba(0,0,0,0.2);
            animation: slideUp 0.4s ease;
        }
        @keyframes slideUp {
            from { transform: translateY(100%); }
            to { transform: translateY(0); }
        }
        #audilix-cookie-banner .cookie-text {
            font-size: 14px;
            color: rgba(255,255,255,0.7);
            line-height: 1.6;
            flex: 1;
        }
        #audilix-cookie-banner .cookie-text strong {
            color: white;
            font-weight: 600;
        }
        #audilix-cookie-banner .cookie-text a {
            color: #C9A84C;
            text-decoration: none;
        }
        #audilix-cookie-banner .cookie-text a:hover {
            text-decoration: underline;
        }
        #audilix-cookie-banner .cookie-actions {
            display: flex;
            gap: 12px;
            flex-shrink: 0;
        }
        #audilix-cookie-banner .cookie-btn-accept {
            background: #C9A84C;
            color: #0B2545;
            border: none;
            padding: 12px 28px;
            border-radius: 4px;
            font-size: 14px;
            font-weight: 700;
            cursor: pointer;
            font-family: 'DM Sans', sans-serif;
            transition: background 0.2s;
        }
        #audilix-cookie-banner .cookie-btn-accept:hover {
            background: #E8C97A;
        }
        #audilix-cookie-banner .cookie-btn-refuse {
            background: transparent;
            color: rgba(255,255,255,0.4);
            border: 1px solid rgba(255,255,255,0.15);
            padding: 12px 20px;
            border-radius: 4px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            font-family: 'DM Sans', sans-serif;
            transition: all 0.2s;
        }
        #audilix-cookie-banner .cookie-btn-refuse:hover {
            color: rgba(255,255,255,0.7);
            border-color: rgba(255,255,255,0.3);
        }
        @media (max-width: 640px) {
            #audilix-cookie-banner {
                flex-direction: column;
                padding: 20px 24px;
                text-align: center;
            }
            #audilix-cookie-banner .cookie-actions {
                width: 100%;
                justify-content: center;
            }
        }
    `;
    document.head.appendChild(style);

    const banner = document.createElement('div');
    banner.id = 'audilix-cookie-banner';
    banner.innerHTML = `
        <div class="cookie-text">
            <strong>🍪 Cookies & confidentialité</strong><br>
            Nous utilisons uniquement des cookies techniques nécessaires au fonctionnement du service. 
            Aucun cookie publicitaire. 
            <a href="/confidentialite.html">En savoir plus</a>
        </div>
        <div class="cookie-actions">
            <button class="cookie-btn-refuse" onclick="audilixRefuseCookies()">Refuser</button>
            <button class="cookie-btn-accept" onclick="audilixAcceptCookies()">Accepter</button>
        </div>
    `;
    document.body.appendChild(banner);

    window.audilixAcceptCookies = function() {
        localStorage.setItem('audilix_cookies_accepted', 'true');
        document.getElementById('audilix-cookie-banner').style.animation = 'slideDown 0.3s ease forwards';
        setTimeout(() => {
            const b = document.getElementById('audilix-cookie-banner');
            if (b) b.remove();
        }, 300);
    };

    window.audilixRefuseCookies = function() {
        localStorage.setItem('audilix_cookies_accepted', 'refused');
        const b = document.getElementById('audilix-cookie-banner');
        if (b) b.remove();
    };

    const slideDownStyle = document.createElement('style');
    slideDownStyle.textContent = `@keyframes slideDown { to { transform: translateY(100%); opacity: 0; } }`;
    document.head.appendChild(slideDownStyle);
})();
