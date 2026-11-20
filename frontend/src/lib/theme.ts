export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "ha.theme";
export const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";
export const THEME_COLORS = { light: "#f3f7f4", dark: "#070d0e" } as const;

// Apply the saved preference before paint, independently of hydration and motion settings.
export const themeScript = `(function(){
var preference='system';
try{var saved=localStorage.getItem('${THEME_STORAGE_KEY}');if(saved==='light'||saved==='dark')preference=saved}catch(e){}
var theme=preference==='system'?(matchMedia('${SYSTEM_THEME_QUERY}').matches?'dark':'light'):preference;
var root=document.documentElement;root.dataset.themePreference=preference;root.dataset.theme=theme;root.style.colorScheme=theme;
var meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=theme==='dark'?'${THEME_COLORS.dark}':'${THEME_COLORS.light}';
})();`;
