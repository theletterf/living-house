// Apps the adapter can work on. Each scenario is plain data: pages with an
// intro line and a few list rows, and controls grouped by page ("view").
// Control kinds: nav, action, toggle, slider, stepper. Toggles, sliders and
// steppers hold a value; an action with `effects` sets several values at once.

export const DEFAULT_SCENARIO = "home";

export const SCENARIOS = {
  home: {
    label: "Smart home",
    noun: "house",
    about: "Hearth, a smart-home app for lights, blinds, climate and security",
    brand: "Hearth",
    pages: {
      overview: { lede: "Good evening. 21.5 °C inside, front door locked.", rows: ["Front door locked · 18:02", "Washing machine finished · 17:40", "Motion in the hallway · 2 min ago"] },
      living: { lede: "Lights, TV and blinds in the living room.", rows: ["21.5 °C · humidity 44%", "Last scene: Movie night (yesterday)", "Window closed"] },
      bedroom: { lede: "Lights and blinds in the bedroom.", rows: ["19.0 °C · humidity 48%", "Wake-up light set for 07:00", "Window tilted"] },
      climate: { lede: "Target temperature for each room.", rows: ["Outside 9 °C, rain later", "Heating on since 16:30", "Energy today: 6.2 kWh"] },
      security: { lede: "Locks, alarm and the garage.", rows: ["All windows closed except the bedroom (tilted)", "Last doorbell ring: 14:12", "Alarm last armed: this morning"] },
    },
    controls: [
      { id: "nav_overview", view: "nav", to: "overview", text: "Overview", desc: "Go to the overview: scenes and recent events" },
      { id: "nav_living", view: "nav", to: "living", text: "Living room", desc: "Go to the living room: lights, TV, blinds" },
      { id: "nav_bedroom", view: "nav", to: "bedroom", text: "Bedroom", desc: "Go to the bedroom: bedside lights, blinds, wake-up light" },
      { id: "nav_climate", view: "nav", to: "climate", text: "Climate", desc: "Go to climate: room temperatures, eco mode, boost" },
      { id: "nav_security", view: "nav", to: "security", text: "Security", desc: "Go to security: door lock, alarm, garage, camera" },

      { id: "sc_movie", view: "overview", kind: "action", text: "Movie night", desc: "Scene: ceiling off, floor lamp on, living room blinds closed, TV on",
        effects: { lr_ceiling: false, lr_lamp: true, lr_blinds: 0, lr_tv: true } },
      { id: "sc_away", view: "overview", kind: "action", text: "Away", desc: "Scene: all lights and TV off, door locked, alarm armed, eco mode on",
        effects: { lr_ceiling: false, lr_lamp: false, lr_tv: false, br_left: false, br_right: false, se_lock: true, se_alarm: true, cl_eco: true } },
      { id: "sc_night", view: "overview", kind: "action", text: "Good night", desc: "Scene: living room off, door locked, bedroom blinds closed",
        effects: { lr_ceiling: false, lr_lamp: false, lr_tv: false, se_lock: true, br_blinds: 0 } },
      { id: "sc_morning", view: "overview", kind: "action", text: "Morning", desc: "Scene: all blinds open, alarm off, bedroom to 21 °C",
        effects: { lr_blinds: 100, br_blinds: 100, se_alarm: false, cl_bedroom: 21 } },

      { id: "lr_ceiling", view: "living", kind: "toggle", text: "Ceiling", desc: "Living room ceiling light", value: true },
      { id: "lr_dim", view: "living", kind: "slider", text: "Ceiling brightness", desc: "Brightness of the living room ceiling light", value: 70, min: 0, max: 100, step: 5, unit: "%" },
      { id: "lr_lamp", view: "living", kind: "toggle", text: "Floor lamp", desc: "Living room floor lamp", value: false },
      { id: "lr_tv", view: "living", kind: "toggle", text: "TV", desc: "Living room TV", value: false },
      { id: "lr_blinds", view: "living", kind: "slider", text: "Blinds", desc: "Living room blinds: 0 closed, 100 fully open", value: 100, min: 0, max: 100, step: 10, unit: "% open" },

      { id: "br_left", view: "bedroom", kind: "toggle", text: "Bedside left", desc: "Left bedside lamp", value: false },
      { id: "br_right", view: "bedroom", kind: "toggle", text: "Bedside right", desc: "Right bedside lamp", value: false },
      { id: "br_blinds", view: "bedroom", kind: "slider", text: "Blinds", desc: "Bedroom blinds: 0 closed, 100 fully open", value: 40, min: 0, max: 100, step: 10, unit: "% open" },
      { id: "br_wake", view: "bedroom", kind: "toggle", text: "Wake-up light", desc: "Light that slowly brightens at 07:00", value: true },

      { id: "cl_living", view: "climate", kind: "stepper", text: "Living room", desc: "Target temperature in the living room", value: 21.5, min: 15, max: 28, step: 0.5, unit: " °C" },
      { id: "cl_bedroom", view: "climate", kind: "stepper", text: "Bedroom", desc: "Target temperature in the bedroom", value: 19, min: 15, max: 28, step: 0.5, unit: " °C" },
      { id: "cl_eco", view: "climate", kind: "toggle", text: "Eco mode", desc: "Lowers every target by 2 °C to save energy", value: false },
      { id: "cl_boost", view: "climate", kind: "action", text: "Boost 30 min", desc: "Heat at full power for 30 minutes" },

      { id: "se_lock", view: "security", kind: "toggle", text: "Front door", desc: "Front door lock", value: true, states: ["Unlocked", "Locked"] },
      { id: "se_alarm", view: "security", kind: "toggle", text: "Alarm", desc: "Burglar alarm", value: false, states: ["Off", "Armed"] },
      { id: "se_garage", view: "security", kind: "toggle", text: "Garage door", desc: "Garage door", value: false, states: ["Closed", "Open"] },
      { id: "se_camera", view: "security", kind: "action", text: "Doorbell camera", desc: "Show the doorbell camera feed" },
    ],
  },

  atrium: {
    label: "Workspace settings",
    noun: "app",
    about: "Atrium, a team workspace app: projects, team members, billing and settings",
    brand: "Atrium",
    // Labels are deliberately vague so there is something to fix.
    pages: {
      home: { lede: "Welcome back. Here's what changed since yesterday.", rows: ["Q4 roadmap edited by Priya", "3 comments on Launch checklist", "Weekly sync notes added"] },
      projects: { lede: "All projects in this workspace.", rows: ["Launch checklist · 12 tasks", "Q4 roadmap · 31 tasks", "Hiring pipeline · 8 tasks"] },
      team: { lede: "Everyone with access to this workspace.", rows: ["Ana Ruiz · Owner", "Sam Okafor · Editor", "Lee Chen · Viewer"] },
      billing: { lede: "Team plan · renews Nov 14.", rows: ["Visa ending 4242", "Oct 2026 · $96.00 · Paid", "Sep 2026 · $96.00 · Paid"] },
      settings: { lede: "Workspace-wide settings.", rows: ["Workspace name: Atrium", "Default time zone: UTC+1", "Data region: EU"] },
    },
    controls: [
      { id: "nav_home", view: "nav", to: "home", text: "Home", desc: "Go to the home page" },
      { id: "nav_projects", view: "nav", to: "projects", text: "Work", desc: "Go to the projects page" },
      { id: "nav_team", view: "nav", to: "team", text: "People", desc: "Go to the team members page" },
      { id: "nav_billing", view: "nav", to: "billing", text: "Account", desc: "Go to billing: plan, payment cards, invoices" },
      { id: "nav_settings", view: "nav", to: "settings", text: "Preferences", desc: "Go to settings: notifications, data export" },

      { id: "h_new", view: "home", text: "New", desc: "Create a new project" },
      { id: "h_sync", view: "home", text: "Sync", desc: "Sync local changes with the server" },
      { id: "h_recent", view: "home", text: "Recent", desc: "Open recently viewed items" },
      { id: "h_updates", view: "home", text: "Updates", desc: "Show the product changelog" },

      { id: "p_create", view: "projects", text: "Create", desc: "Start a new project from a template" },
      { id: "p_shelve", view: "projects", text: "Shelve", desc: "Archive the selected project" },
      { id: "p_link", view: "projects", text: "Link", desc: "Copy a share link for the selected project" },
      { id: "p_labels", view: "projects", text: "Labels", desc: "Edit the selected project's tags" },

      { id: "t_roles", view: "team", text: "Roles", desc: "Change what each member can do" },
      { id: "t_groups", view: "team", text: "Groups", desc: "Organize members into groups" },
      { id: "t_seats", view: "team", text: "Seats", desc: "Invite teammates by email and manage seats" },
      { id: "t_activity", view: "team", text: "Activity", desc: "See who did what and when" },

      { id: "b_plan", view: "billing", text: "Plan", desc: "Change or cancel your subscription" },
      { id: "b_methods", view: "billing", text: "Methods", desc: "Add or remove payment cards" },
      { id: "b_statements", view: "billing", text: "Statements", desc: "Download past invoices as PDF" },
      { id: "b_usage", view: "billing", text: "Usage", desc: "See seats and storage used this month" },

      { id: "s_general", view: "settings", text: "General", desc: "Rename the workspace and set the time zone" },
      { id: "s_signals", view: "settings", text: "Signals", desc: "Choose which email and push notifications you get" },
      { id: "s_takeout", view: "settings", text: "Takeout", desc: "Export all workspace data as a ZIP file" },
      { id: "s_danger", view: "settings", text: "Danger zone", desc: "Delete the workspace" },
    ],
  },
};
