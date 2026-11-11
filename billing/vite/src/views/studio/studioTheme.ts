// billing/vite/src/views/studio/studioTheme.ts
//
// AG Studio, dressed as MeterPal.
//
// Studio ships a light theme. Dropped into this dashboard untouched it reads
// as a white sheet pasted over a dark app -- the canvas, the panels and the
// widget cards are all #FFFFFF while everything around them is #161616.
//
// So we build one theme from the dashboard's own tokens and register it twice,
// once per colour mode. Studio resolves the mode from a `data-ag-theme-mode`
// attribute on an ancestor, which the view sets from the app's ThemeProvider,
// so the studio follows the app's light/dark switch instead of fighting it.
//
// Two rules held throughout:
//
//   - Widgets are cards, not windows. They sit a shade *below* the canvas with
//     a hairline border, exactly like the dashboard's own cards (#121212 on
//     #161616, border #222).
//   - Chrome recedes. Panel headers, axis labels and captions are subtle; the
//     data and the numbers are the only things at full contrast.

import {
	studioTheme,
	type AgStudioTheme,
	type AgStudioThemeParams,
} from "ag-studio";

const FONT = '"Inter", "Inter Fallback", system-ui, -apple-system, sans-serif';

// The dashboard's chart series, in order. Shared by both modes: these are the
// same colours the rest of the app's charts use, so a studio chart and a
// classic chart of the same data read as the same thing.
const SERIES = [
	"#5d7cc4",
	"#ee3e36",
	"#199e70",
	"#e0a92e",
	"#d55181",
	"#008300",
	"#3987e5",
	"#e66767",
	"#525252",
];

const SERIES_STROKES = [
	"#4a67ad",
	"#d02a23",
	"#138a5e",
	"#c8911f",
	"#bf3d6e",
	"#006f00",
	"#2b76d1",
	"#d24f4f",
	"#3f3f3f",
];

// The palette is built by index (`chartPaletteFills1Color`, ...) rather than
// written out, so it is typed as a plain string map and spread into the theme
// below. Typing it as the full params object instead made every other key in
// `SHARED` read as "specified more than once", since a complete params object
// may contain any of them.
const chartPalette: Record<string, string> = {
	...Object.fromEntries(
		SERIES.map((color, index) => [`chartPaletteFills${index + 1}Color`, color]),
	),
	...Object.fromEntries(
		SERIES_STROKES.map((color, index) => [
			`chartPaletteStrokes${index + 1}Color`,
			color,
		]),
	),
};

/**
 * Chrome that is identical in both modes: geometry, the type ramp, and the
 * behaviour of anything that opens over the top of the studio.
 */
const SHARED: Partial<AgStudioThemeParams> = {
	fontFamily: FONT,
	fontSize: 13,
	fontWeight: 400,
	borderWidth: 1,
	borderRadius: 6,
	spacing: 8,
	accentColor: "#0088ff",

	// Inputs and buttons: quiet surfaces, one hairline, a real focus ring.
	inputBorderRadius: 6,
	inputHeight: 30,
	buttonBorderRadius: 6,
	buttonFontWeight: "500",
	buttonVerticalPadding: 5,
	buttonHorizontalPadding: 10,
	iconSize: 16,
	tabBorderRadius: 6,
	tabSpacing: 2,
	tabBarBottomPadding: 0,
	tabSelectedShadow: "none",
	studioPanelItemBorderRadius: 6,

	// Popups float above everything, so they get the only real shadow.
	popupShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
	dialogShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
	dropdownShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
	menuShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",

	// Panels: narrow enough that the canvas stays the subject of the page.
	// Filters, opened, costs the canvas ~200px; at 224 the KPI tiles stopped
	// being able to hold their own numbers.
	studioPanelWidth: 208,
	studioPanelMinWidth: 176,
	studioPanelMaxWidth: 420,
	studioAiPanelWidth: 288,
	studioPanelHeaderFontFamily: FONT,
	studioPanelHeaderFontSize: 12,
	studioPanelHeaderFontWeight: "500",
	studioPanelHeaderHeight: 40,

	// The canvas is allowed to get narrow. Studio's defaults floor it at 720px,
	// which on a laptop with the assistant open is wider than the space it has
	// -- so it overflows and the right-hand widgets are clipped instead of
	// scaled. A dashboard that fits is worth more than one that is 720px wide.
	studioMinWidth: 0,
	studioResponsiveMinWidth: 0,
	studioCanvasMinWidth: 0,
	studioCanvasColumnsScale: 24,
	studioCanvasRowHeight: 16,
	studioCanvasPadding: 8,

	// Widgets: the title is a label, not a headline. The number is the point.
	studioWidgetBorderRadius: 10,
	studioWidgetPadding: 6,
	studioWidgetTitleFontFamily: FONT,
	studioWidgetTitleFontSize: 13,
	studioWidgetTitleFontWeight: "500",
	studioWidgetSubtitleFontFamily: FONT,
	studioWidgetSubtitleFontSize: 11,
	studioWidgetCaptionFontFamily: FONT,
	studioWidgetCaptionFontSize: 11,
	studioValueWidgetFontSize: 30,
	studioTextWidgetFontSize: 18,

	// Grids: denser than the default, and header-less in feel -- the header is
	// a label row, so it gets the subtle colour and no fill.
	gridFontFamily: FONT,
	gridFontSize: 12,
	gridHeaderFontFamily: FONT,
	gridHeaderFontSize: 11,
	gridHeaderFontWeight: "500",
	gridRowHeight: 34,
	gridCellHorizontalPadding: 12,
	gridWrapperBorderRadius: 0,
	// Columns are separated by alignment and space, not by rules.
	gridColumnBorder: false,

	// Charts: hairline axes, a very quiet grid, colour only in the series.
	chartFontFamily: FONT,
	chartFontSize: 11,
	chartAxisLabelFontFamily: FONT,
	chartAxisLabelFontSize: 11,
	chartAxisLineWidth: 1,
	chartGridLineWidth: 1,
	chartLegendLabelFontFamily: FONT,
	chartLegendLabelFontSize: 11,
	chartSeriesLabelFontFamily: FONT,
	chartSeriesLabelFontSize: 11,
	chartBorderWidth: 0,
	chartChartPadding: 8,
	...chartPalette,
};

const DARK: Partial<AgStudioThemeParams> = {
	...SHARED,
	browserColorScheme: "dark",

	// Surfaces, darkest to lightest: card -> page -> raised.
	backgroundColor: "#161616",
	foregroundColor: "#dcdcdc",
	textColor: "#dcdcdc",
	subtleTextColor: "#8f8f8f",
	borderColor: "#242424",
	iconColor: "#8f8f8f",

	inputBackgroundColor: "#1d1d1d",
	inputBorder: { width: 1, color: "#2c2c2c" },
	inputTextColor: "#dcdcdc",
	inputPlaceholderTextColor: "#6f6f6f",
	inputFocusBackgroundColor: "#1d1d1d",
	inputFocusBorder: { width: 1, color: "#0088ff" },
	inputFocusShadow: "0 0 0 3px rgba(0, 136, 255, 0.18)",
	inputIconColor: "#8f8f8f",

	buttonBackgroundColor: "#1d1d1d",
	buttonBorder: { width: 1, color: "#2c2c2c" },
	buttonTextColor: "#dcdcdc",
	buttonHoverBackgroundColor: "#242424",
	buttonHoverBorder: { width: 1, color: "#3a3a3a" },
	buttonHoverTextColor: "#ffffff",
	buttonActiveBackgroundColor: "#242424",
	buttonActiveBorder: { width: 1, color: "#0088ff" },
	buttonActiveTextColor: "#ffffff",

	tabBackgroundColor: "transparent",
	tabBarBackgroundColor: "transparent",
	tabBarBorder: false,
	tabTextColor: "#8f8f8f",
	tabHoverBackgroundColor: "#1d1d1d",
	tabHoverTextColor: "#dcdcdc",
	tabSelectedBackgroundColor: "#242424",
	tabSelectedTextColor: "#ffffff",
	tabSelectedBorderColor: "#0088ff",
	tabSelectedBorderWidth: 0,

	menuBackgroundColor: "#1b1b1b",
	menuBorder: { width: 1, color: "#2c2c2c" },
	menuTextColor: "#dcdcdc",
	menuSeparatorColor: "#2c2c2c",
	rowHoverColor: "rgba(255, 255, 255, 0.05)",

	tooltipBackgroundColor: "#242424",
	tooltipBorder: { width: 1, color: "#333333" },
	tooltipTextColor: "#e8e8e8",

	scrollbarThumbColor: "rgba(255, 255, 255, 0.14)",
	scrollbarTrackColor: "transparent",
	scrollbarWidth: "thin",

	toggleButtonOnBackgroundColor: "#0088ff",
	toggleButtonOffBackgroundColor: "#2c2c2c",
	toggleButtonSwitchBackgroundColor: "#ffffff",

	// Studio chrome. The canvas is the page; the panels are the page too, split
	// by a hairline rather than by a change of colour.
	studioWrapperBackgroundColor: "#161616",
	studioWrapperBorder: false,
	studioWrapperBorderRadius: 0,
	studioWrapperSpacing: 0,
	studioPanelContainerBackgroundColor: "#161616",
	studioPanelContainerBorder: false,
	studioPanelContainerBorderRadius: 0,
	studioPanelDividerColor: "#242424",
	studioPanelDividerWidth: 1,
	studioPanelDividerActiveColor: "#0088ff",
	studioPanelGroupBackgroundColor: "#1d1d1d",
	studioPanelGroupTitleBarTextColor: "#8f8f8f",
	studioPanelSectionBorderColor: "#242424",
	studioPanelChevronButtonHoverBackgroundColor: "#242424",
	studioPanelChevronButtonHoverColor: "#dcdcdc",
	studioIconButtonHoverBackgroundColor: "#242424",
	studioIconButtonHoverColor: "#ffffff",
	studioFiltersPanelCardSubtleColor: "#8f8f8f",
	studioFiltersPanelCardIconSubtleHoverColor: "#dcdcdc",

	studioCanvasBackgroundColor: "#161616",
	studioCanvasFontFamily: FONT,
	studioCanvasBorderRadius: 0,
	studioCanvasGridLineColor: "rgba(255, 255, 255, 0.035)",
	studioCanvasDragPreviewBackgroundColor: "#1d1d1d",
	studioCanvasDragPreviewShadow: "0 8px 24px rgba(0, 0, 0, 0.5)",

	studioWidgetBackgroundColor: "#121212",
	studioWidgetBorder: { width: 1, color: "#242424" },
	studioWidgetTitleTextColor: "#dcdcdc",
	studioWidgetSubtitleTextColor: "#8f8f8f",
	studioWidgetCaptionTextColor: "#8f8f8f",
	studioWidgetSelectedBorderColor: "#0088ff",
	studioWidgetResizeBorderColor: "#0088ff",
	studioWidgetShadow: "none",
	studioWidgetToolbarBackgroundColor: "#1b1b1b",
	studioWidgetToolbarBorder: { width: 1, color: "#2c2c2c" },
	studioWidgetToolbarButtonColor: "#a8a8a8",
	studioWidgetToolbarButtonHoverBackgroundColor: "#242424",
	studioWidgetToolbarShadow: "0 8px 24px rgba(0, 0, 0, 0.45)",
	studioWidgetLoadingOverlayBackgroundColor: "rgba(18, 18, 18, 0.7)",
	studioWidgetNoDataOverlayBackgroundColor: "rgba(18, 18, 18, 0.7)",
	studioWidgetInvalidConfigurationOverlayBackgroundColor:
		"rgba(18, 18, 18, 0.8)",
	studioLinearGaugeLabelColor: "#ffffff",

	// The assistant is a panel, not a chat app: same surface as the rest of the
	// chrome, with the input one step up so it reads as the one thing to touch.
	studioAiPanelInputMessageBackgroundColor: "#1d1d1d",
	studioAiPanelButtonHoverBackgroundColor: "#242424",
	studioAiPanelRichTextAccentBackgroundColor: "rgba(0, 136, 255, 0.12)",

	// Grids inside widgets.
	gridHeaderTextColor: "#8f8f8f",
	gridCellTextColor: "#c9c9c9",
	gridDataBackgroundColor: "transparent",
	gridOddRowBackgroundColor: "transparent",
	gridHeaderBackgroundColor: "transparent",
	gridRowBorder: { width: 1, color: "#1f1f1f" },
	gridHeaderRowBorder: { width: 1, color: "#242424" },
	gridRowHoverColor: "rgba(255, 255, 255, 0.04)",
	gridIconColor: "#8f8f8f",
	gridAccentColor: "#0088ff",

	// Charts inside widgets.
	chartTextColor: "#dcdcdc",
	chartSubtleTextColor: "#8f8f8f",
	chartAxisLabelColor: "#8f8f8f",
	chartAxisTitleColor: "#8f8f8f",
	chartAxisLineColor: "#2a2a2a",
	chartGridLineColor: "#242424",
	chartLegendLabelColor: "#a8a8a8",
	chartBorderColor: "transparent",
	chartTooltipBackgroundColor: "#1b1b1b",
	chartTooltipBorder: { width: 1, color: "#2c2c2c" },
	chartTooltipTextColor: "#e8e8e8",
	chartSeriesLabelInsideTextColor: "#0d0d0d",
	chartSeriesLabelOutsideTextColor: "#a8a8a8",
	chartAccentColor: "#0088ff",
};

const LIGHT: Partial<AgStudioThemeParams> = {
	...SHARED,
	browserColorScheme: "light",

	backgroundColor: "#fafaf9",
	foregroundColor: "#121212",
	textColor: "#121212",
	subtleTextColor: "#767676",
	borderColor: "#e5e5e5",
	iconColor: "#767676",

	inputBackgroundColor: "#ffffff",
	inputBorder: { width: 1, color: "#e0e0e0" },
	inputTextColor: "#121212",
	inputPlaceholderTextColor: "#aaaaaa",
	inputFocusBackgroundColor: "#ffffff",
	inputFocusBorder: { width: 1, color: "#0088ff" },
	inputFocusShadow: "0 0 0 3px rgba(0, 136, 255, 0.15)",
	inputIconColor: "#767676",

	buttonBackgroundColor: "#ffffff",
	buttonBorder: { width: 1, color: "#e0e0e0" },
	buttonTextColor: "#121212",
	buttonHoverBackgroundColor: "#f5f5f4",
	buttonHoverBorder: { width: 1, color: "#d4d4d4" },
	buttonHoverTextColor: "#000000",
	buttonActiveBackgroundColor: "#f0f8ff",
	buttonActiveBorder: { width: 1, color: "#0088ff" },
	buttonActiveTextColor: "#0088ff",

	tabBackgroundColor: "transparent",
	tabBarBackgroundColor: "transparent",
	tabBarBorder: false,
	tabTextColor: "#767676",
	tabHoverBackgroundColor: "#f5f5f4",
	tabHoverTextColor: "#121212",
	tabSelectedBackgroundColor: "#ffffff",
	tabSelectedTextColor: "#121212",
	tabSelectedBorderColor: "#0088ff",
	tabSelectedBorderWidth: 0,

	menuBackgroundColor: "#ffffff",
	menuBorder: { width: 1, color: "#e5e5e5" },
	menuTextColor: "#121212",
	menuSeparatorColor: "#eaeae9",
	rowHoverColor: "rgba(0, 0, 0, 0.04)",

	tooltipBackgroundColor: "#121212",
	tooltipBorder: { width: 1, color: "#121212" },
	tooltipTextColor: "#ffffff",

	scrollbarThumbColor: "rgba(0, 0, 0, 0.18)",
	scrollbarTrackColor: "transparent",
	scrollbarWidth: "thin",

	toggleButtonOnBackgroundColor: "#0088ff",
	toggleButtonOffBackgroundColor: "#e0e0e0",
	toggleButtonSwitchBackgroundColor: "#ffffff",

	studioWrapperBackgroundColor: "#fafaf9",
	studioWrapperBorder: false,
	studioWrapperBorderRadius: 0,
	studioWrapperSpacing: 0,
	studioPanelContainerBackgroundColor: "#fafaf9",
	studioPanelContainerBorder: false,
	studioPanelContainerBorderRadius: 0,
	studioPanelDividerColor: "#e5e5e5",
	studioPanelDividerWidth: 1,
	studioPanelDividerActiveColor: "#0088ff",
	studioPanelGroupBackgroundColor: "#f2f2f1",
	studioPanelGroupTitleBarTextColor: "#767676",
	studioPanelSectionBorderColor: "#eaeae9",
	studioPanelChevronButtonHoverBackgroundColor: "#f0f0ef",
	studioPanelChevronButtonHoverColor: "#121212",
	studioIconButtonHoverBackgroundColor: "#f0f0ef",
	studioIconButtonHoverColor: "#121212",
	studioFiltersPanelCardSubtleColor: "#767676",
	studioFiltersPanelCardIconSubtleHoverColor: "#121212",

	studioCanvasBackgroundColor: "#fafaf9",
	studioCanvasFontFamily: FONT,
	studioCanvasBorderRadius: 0,
	studioCanvasGridLineColor: "rgba(0, 0, 0, 0.04)",
	studioCanvasDragPreviewBackgroundColor: "#ffffff",
	studioCanvasDragPreviewShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",

	studioWidgetBackgroundColor: "#ffffff",
	studioWidgetBorder: { width: 1, color: "#e5e5e5" },
	studioWidgetTitleTextColor: "#121212",
	studioWidgetSubtitleTextColor: "#767676",
	studioWidgetCaptionTextColor: "#767676",
	studioWidgetSelectedBorderColor: "#0088ff",
	studioWidgetResizeBorderColor: "#0088ff",
	studioWidgetShadow: "none",
	studioWidgetToolbarBackgroundColor: "#ffffff",
	studioWidgetToolbarBorder: { width: 1, color: "#e5e5e5" },
	studioWidgetToolbarButtonColor: "#767676",
	studioWidgetToolbarButtonHoverBackgroundColor: "#f5f5f4",
	studioWidgetToolbarShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
	studioWidgetLoadingOverlayBackgroundColor: "rgba(255, 255, 255, 0.7)",
	studioWidgetNoDataOverlayBackgroundColor: "rgba(255, 255, 255, 0.7)",
	studioWidgetInvalidConfigurationOverlayBackgroundColor:
		"rgba(255, 255, 255, 0.8)",
	studioLinearGaugeLabelColor: "#ffffff",

	studioAiPanelInputMessageBackgroundColor: "#ffffff",
	studioAiPanelButtonHoverBackgroundColor: "#f0f0ef",
	studioAiPanelRichTextAccentBackgroundColor: "rgba(0, 136, 255, 0.08)",

	gridHeaderTextColor: "#767676",
	gridCellTextColor: "#333333",
	gridDataBackgroundColor: "transparent",
	gridOddRowBackgroundColor: "transparent",
	gridHeaderBackgroundColor: "transparent",
	gridRowBorder: { width: 1, color: "#f0f0ef" },
	gridHeaderRowBorder: { width: 1, color: "#e5e5e5" },
	gridRowHoverColor: "rgba(0, 0, 0, 0.03)",
	gridIconColor: "#767676",
	gridAccentColor: "#0088ff",

	chartTextColor: "#121212",
	chartSubtleTextColor: "#767676",
	chartAxisLabelColor: "#767676",
	chartAxisTitleColor: "#767676",
	chartAxisLineColor: "#d4d4d4",
	chartGridLineColor: "#ececeb",
	chartLegendLabelColor: "#555555",
	chartBorderColor: "transparent",
	chartTooltipBackgroundColor: "#ffffff",
	chartTooltipBorder: { width: 1, color: "#e5e5e5" },
	chartTooltipTextColor: "#121212",
	chartSeriesLabelInsideTextColor: "#ffffff",
	chartSeriesLabelOutsideTextColor: "#555555",
	chartAccentColor: "#0088ff",
};

/**
 * One theme, two colour modes.
 *
 * Studio picks the mode from `data-ag-theme-mode` on an ancestor carrying the
 * `ag-theme-mode` class, so the view drives it from the app's theme context and
 * the studio follows the dashboard's light/dark switch.
 */
export const meterpalStudioTheme: AgStudioTheme = studioTheme
	.withParams(LIGHT, "light")
	.withParams(DARK, "dark");
