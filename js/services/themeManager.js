// Theme Manager Service
// Dark mode switch in the social media menu. Follows the device's
// prefers-color-scheme setting until the user flips the switch; the flipped
// choice is remembered. Flipping back to whatever the device uses clears the
// saved choice, so the page follows the device again.
// The saved choice is applied early by an inline script in index.html's <head>
// to avoid a flash of the wrong theme.

class ThemeManager {
    constructor() {
        this.STORAGE_KEY = 'one-host-theme';
        this.systemQuery = window.matchMedia('(prefers-color-scheme: dark)');
        this.savedTheme = this.getSavedTheme(); // 'light', 'dark' or null (follow device)
        this.toggleButton = null;
        this.toggleIcon = null;
    }

    init() {
        this.toggleButton = document.getElementById('theme-toggle');
        this.toggleIcon = document.getElementById('theme-toggle-icon');

        this.applyTheme();

        // Keep the switch in step with the device while no choice is saved
        const onSystemChange = () => {
            if (!this.savedTheme) this.applyTheme();
        };
        if (this.systemQuery.addEventListener) {
            this.systemQuery.addEventListener('change', onSystemChange);
        } else if (this.systemQuery.addListener) {
            this.systemQuery.addListener(onSystemChange); // Older Safari
        }

        if (!this.toggleButton) {
            console.error('Theme toggle element not found!');
            return;
        }

        this.toggleButton.addEventListener('click', (e) => {
            e.stopPropagation(); // Keep the social media menu open
            this.toggle();
        });
    }

    getSystemTheme() {
        return this.systemQuery.matches ? 'dark' : 'light';
    }

    getEffectiveTheme() {
        return this.savedTheme || this.getSystemTheme();
    }

    getSavedTheme() {
        try {
            const saved = localStorage.getItem(this.STORAGE_KEY);
            if (saved === 'light' || saved === 'dark') {
                return saved;
            }
        } catch (error) {
            console.debug('Theme preference not readable:', error);
        }
        return null;
    }

    toggle() {
        const nextTheme = this.getEffectiveTheme() === 'dark' ? 'light' : 'dark';
        // Matching the device again means "follow the device"
        this.savedTheme = nextTheme === this.getSystemTheme() ? null : nextTheme;

        try {
            if (this.savedTheme) {
                localStorage.setItem(this.STORAGE_KEY, this.savedTheme);
            } else {
                localStorage.removeItem(this.STORAGE_KEY);
            }
        } catch (error) {
            console.debug('Theme preference not saved:', error);
        }

        this.applyTheme();

        if (typeof Analytics !== 'undefined') {
            Analytics.track('theme_changed', {
                theme: nextTheme,
                follows_system: !this.savedTheme
            });
        }
    }

    applyTheme() {
        // No saved choice removes the attribute so the prefers-color-scheme media query decides
        if (this.savedTheme) {
            document.documentElement.setAttribute('data-theme', this.savedTheme);
        } else {
            document.documentElement.removeAttribute('data-theme');
        }

        const isDark = this.getEffectiveTheme() === 'dark';
        if (this.toggleIcon) {
            this.toggleIcon.textContent = isDark ? 'dark_mode' : 'light_mode';
        }
        if (this.toggleButton) {
            this.toggleButton.setAttribute('aria-checked', String(isDark));
            this.toggleButton.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
        }

        // Let parts drawn in JS (e.g. the QR code) pick up the new colours
        window.dispatchEvent(new CustomEvent('themechange', {
            detail: { theme: this.getEffectiveTheme() }
        }));
    }
}

// Export for use in other modules or attach to window
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ThemeManager;
} else {
    window.ThemeManager = ThemeManager;
    window.themeManager = new ThemeManager();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.themeManager.init());
    } else {
        window.themeManager.init();
    }
}
