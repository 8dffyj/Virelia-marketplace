// public/js/inspect-protection.js
(function() {
    'use strict';
    
    let devToolsOpen = false;
    let checkInterval = null;
    
    // Console warning
    console.clear();
    console.log('%cSTOP!', 'color: red; font-size: 50px; font-weight: bold; text-shadow: 2px 2px 4px rgba(0,0,0,0.5);');
    console.log('%cThis is a browser feature intended for developers.', 'color: red; font-size: 16px; font-weight: bold;');
    console.log('%cIf someone told you to copy-paste something here, it is a scam and will give them access to your account.', 'color: red; font-size: 14px;');
    console.log('%cUnauthorized access may result in account suspension.', 'color: orange; font-size: 14px;');

    // Disable right-click context menu
    document.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        showNotification('Right-click disabled for security');
        return false;
    }, false);

    // Block common developer shortcuts
    document.addEventListener('keydown', function(e) {
        const key = e.keyCode || e.which;
        const ctrl = e.ctrlKey;
        const shift = e.shiftKey;
        const alt = e.altKey;
        const cmd = e.metaKey;

        // F12 - Developer Tools
        if (key === 123) {
            e.preventDefault();
            e.stopPropagation();
            showNotification('Developer tools access blocked');
            return false;
        }

        // Ctrl+Shift+I or Cmd+Opt+I - Inspector
        if ((ctrl || cmd) && shift && key === 73) {
            e.preventDefault();
            e.stopPropagation();
            showNotification('Inspector access blocked');
            return false;
        }

        // Ctrl+Shift+J or Cmd+Opt+J - Console
        if ((ctrl || cmd) && shift && key === 74) {
            e.preventDefault();
            e.stopPropagation();
            showNotification('Console access blocked');
            return false;
        }

        // Ctrl+U or Cmd+U - View Source
        if ((ctrl || cmd) && key === 85) {
            e.preventDefault();
            e.stopPropagation();
            showNotification('View source blocked');
            return false;
        }

        // Ctrl+Shift+C or Cmd+Opt+C - Element Inspector
        if ((ctrl || cmd) && shift && key === 67) {
            e.preventDefault();
            e.stopPropagation();
            showNotification('Element inspector blocked');
            return false;
        }

        // Ctrl+S or Cmd+S - Save
        if ((ctrl || cmd) && key === 83) {
            e.preventDefault();
            e.stopPropagation();
            showNotification('Save page blocked');
            return false;
        }

        // Ctrl+A or Cmd+A - Select All (optional)
        if ((ctrl || cmd) && key === 65) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }

        // Ctrl+P or Cmd+P - Print
        if ((ctrl || cmd) && key === 80) {
            e.preventDefault();
            e.stopPropagation();
            showNotification('Print blocked');
            return false;
        }

        // F5 and Ctrl+R - Refresh (optional, might be annoying)
        // Uncomment if you want to block refresh
        /*
        if (key === 116 || ((ctrl || cmd) && key === 82)) {
            e.preventDefault();
            e.stopPropagation();
            showNotification('Page refresh blocked');
            return false;
        }
        */
    }, true);

    // Disable text selection
    document.addEventListener('selectstart', function(e) {
        e.preventDefault();
        return false;
    });

    // Disable drag and drop
    document.addEventListener('dragstart', function(e) {
        e.preventDefault();
        return false;
    });

    // Developer tools detection
    function detectDevTools() {
        const threshold = 160;
        
        setInterval(function() {
            if (window.outerHeight - window.innerHeight > threshold || 
                window.outerWidth - window.innerWidth > threshold) {
                if (!devToolsOpen) {
                    devToolsOpen = true;
                    handleDevToolsOpen();
                }
            } else {
                if (devToolsOpen) {
                    devToolsOpen = false;
                    handleDevToolsClosed();
                }
            }
        }, 500);
    }

    // Console detection method
    function detectConsoleUsage() {
        let consoleDetected = false;
        
        setInterval(function() {
            const before = performance.now();
            console.clear();
            const after = performance.now();
            
            if (after - before > 100 && !consoleDetected) {
                consoleDetected = true;
                handleDevToolsOpen();
                setTimeout(() => { consoleDetected = false; }, 5000);
            }
        }, 2000);
    }

    // Debugger detection
    function detectDebugger() {
        setInterval(function() {
            const start = performance.now();
            debugger;
            const end = performance.now();
            
            if (end - start > 100) {
                handleDevToolsOpen();
            }
        }, 3000);
    }

    // Handle dev tools detection
    function handleDevToolsOpen() {
        console.clear();
        console.log('%cDEVELOPER TOOLS DETECTED!', 'color: red; font-size: 30px; font-weight: bold;');
        console.log('%cThis activity is being logged for security purposes.', 'color: red; font-size: 16px;');
        
        showDevToolsWarning();
        
        // Optional: More aggressive measures
        // Uncomment any of these if you want stricter protection:
        
        // Blur the page content
        // document.body.style.filter = 'blur(5px)';
        
        // Hide the page content
        // document.body.style.display = 'none';
        
        // Redirect to warning page
        // window.location.href = '/security-warning';
        
        // Show full screen warning
        // showFullScreenWarning();
    }

    function handleDevToolsClosed() {
        hideDevToolsWarning();
        
        // Restore page if it was modified
        // document.body.style.filter = '';
        // document.body.style.display = '';
    }

    // Show dev tools warning
    function showDevToolsWarning() {
        let warning = document.getElementById('devtools-warning');
        if (!warning) {
            warning = document.createElement('div');
            warning.id = 'devtools-warning';
            warning.innerHTML = `
                <div style="
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    background: rgba(255, 0, 0, 0.9);
                    color: white;
                    padding: 15px;
                    text-align: center;
                    font-size: 18px;
                    font-weight: bold;
                    z-index: 999999;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.3);
                    border-bottom: 3px solid #ff0000;
                    animation: pulse 1s infinite;
                ">
                    ⚠️ SECURITY ALERT: Developer Tools Detected! ⚠️<br>
                    <span style="font-size: 14px;">Please close developer tools to continue. This activity is being monitored.</span>
                </div>
            `;
            document.body.appendChild(warning);
        }
        warning.style.display = 'block';
    }

    function hideDevToolsWarning() {
        const warning = document.getElementById('devtools-warning');
        if (warning) {
            warning.style.display = 'none';
        }
    }

    // Show notification
    function showNotification(message) {
        console.warn('Security: ' + message);
        
        // Optional: Show visual notification
        let notification = document.getElementById('security-notification');
        if (!notification) {
            notification = document.createElement('div');
            notification.id = 'security-notification';
            notification.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background: rgba(255, 165, 0, 0.95);
                color: white;
                padding: 10px 15px;
                border-radius: 5px;
                font-size: 14px;
                font-weight: bold;
                z-index: 999999;
                box-shadow: 0 2px 10px rgba(0,0,0,0.3);
                transition: opacity 0.3s ease;
            `;
            document.body.appendChild(notification);
        }
        
        notification.textContent = message;
        notification.style.opacity = '1';
        notification.style.display = 'block';
        
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => {
                notification.style.display = 'none';
            }, 300);
        }, 3000);
    }

    // Clear console periodically
    setInterval(function() {
        console.clear();
        console.log('%c🔒 PROTECTED CONTENT - ACCESS MONITORED', 'color: red; font-size: 16px; font-weight: bold;');
    }, 5000);

    // Disable print
    window.addEventListener('beforeprint', function(e) {
        e.preventDefault();
        showNotification('Print functionality disabled');
        return false;
    });

    // Monitor window focus
    window.addEventListener('blur', function() {
        setTimeout(function() {
            if (!document.hasFocus()) {
                console.log('%cWindow focus lost - potential dev tools usage', 'color: orange; font-size: 14px;');
            }
        }, 100);
    });

    // Initialize all detection methods
    function initProtection() {
        detectDevTools();
        detectConsoleUsage();
        detectDebugger();
        
        console.log('%cInspect protection initialized', 'color: green; font-size: 12px;');
    }

    // Start protection when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initProtection);
    } else {
        initProtection();
    }

    // CSS injection for additional protection
    const style = document.createElement('style');
    style.textContent = `
        /* Disable text selection */
        * {
            -webkit-user-select: none !important;
            -moz-user-select: none !important;
            -ms-user-select: none !important;
            user-select: none !important;
        }
        
        /* Allow selection for input fields */
        input, textarea {
            -webkit-user-select: text !important;
            -moz-user-select: text !important;
            -ms-user-select: text !important;
            user-select: text !important;
        }
        
        /* Hide scrollbars */
        ::-webkit-scrollbar {
            width: 0px;
            background: transparent;
        }
        
        /* Disable image drag */
        img {
            -webkit-user-drag: none !important;
            -moz-user-drag: none !important;
            user-drag: none !important;
            pointer-events: none !important;
        }
        
        /* Pulse animation for warnings */
        @keyframes pulse {
            0% { opacity: 0.8; }
            50% { opacity: 1; }
            100% { opacity: 0.8; }
        }
    `;
    document.head.appendChild(style);

})();