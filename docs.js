// Help articles, written against element IDs instead of labels or screenshots.
// {{id}} renders the element's current label in this person's layout (with
// "formerly …" if it was renamed, and a Show me link); {{value:id}} renders
// its current state. A paragraph starting with {{if pinned:id}} or
// {{unless pinned:id}} only shows when that holds, so advice can follow the
// layout. IDs never change, so the help always matches the UI.

export const DOCS = {
  home: [
    {
      id: "movie",
      title: "Start a movie night",
      body: "On {{nav_overview}}, choose {{sc_movie}}. It switches off {{lr_ceiling}}, turns on {{lr_lamp}} and {{lr_tv}}, and closes {{lr_blinds}}.\n\nTo get the room back, open {{nav_living}} and switch {{lr_ceiling}} on again.",
    },
    {
      id: "away",
      title: "Leave the house",
      body: "On {{nav_overview}}, choose {{sc_away}}: lights and TV go off, {{se_lock}} locks, {{se_alarm}} arms and {{cl_eco}} turns on.\n\nThe scene doesn't touch the garage. {{se_garage}} is {{value:se_garage}} right now; you'll find it in {{nav_security}}.",
    },
    {
      id: "lock",
      title: "Lock or unlock the front door",
      body: "Open {{nav_security}} and switch {{se_lock}}. The door is {{value:se_lock}} right now.\n\n{{unless pinned:se_lock}} If you do this often, ask the house to pin it to your Quick actions.\n\n{{if pinned:se_lock}} Because it's pinned, you can also switch it from the Quick actions bar on any page.",
    },
    {
      id: "temperature",
      title: "Change the temperature",
      body: "Open {{nav_climate}} and use − and + on {{cl_living}} or {{cl_bedroom}}. The targets are {{value:cl_living}} and {{value:cl_bedroom}} right now.\n\n{{cl_eco}} lowers every target by 2 °C. {{cl_boost}} heats at full power for 30 minutes.",
    },
    {
      id: "wake",
      title: "Wake up gently",
      body: "Open {{nav_bedroom}} and switch on {{br_wake}}; it brightens slowly at 07:00. It's {{value:br_wake}} right now.\n\nIn the morning, {{sc_morning}} on {{nav_overview}} opens all blinds and switches off {{se_alarm}}.",
    },
    {
      id: "dim",
      title: "Dim the lights or close the blinds",
      body: "Open {{nav_living}} and drag {{lr_dim}} (now {{value:lr_dim}}). {{lr_blinds}} work the same way: 0 is closed, 100 fully open. They're {{value:lr_blinds}} right now.\n\nThe bedroom has its own {{br_blinds}} in {{nav_bedroom}}.",
    },
    {
      id: "door",
      title: "See who's at the door",
      body: "Open {{nav_security}} and choose {{se_camera}} to see the doorbell camera.",
    },
  ],

  atrium: [
    {
      id: "invoice",
      title: "Download an invoice",
      body: "Open {{nav_billing}} and choose {{b_statements}}. Invoices download as PDF files.",
    },
    {
      id: "invite",
      title: "Invite a teammate",
      body: "Open {{nav_team}} and choose {{t_seats}} to invite people by email.",
    },
    {
      id: "notifications",
      title: "Turn off email notifications",
      body: "Open {{nav_settings}} and choose {{s_signals}}.",
    },
    {
      id: "export",
      title: "Export all your data",
      body: "Open {{nav_settings}} and choose {{s_takeout}}. You get a ZIP file with everything in the workspace.",
    },
    {
      id: "share",
      title: "Share a project",
      body: "Open {{nav_projects}}, select a project and choose {{p_link}} to copy a link to it.",
    },
    {
      id: "plan",
      title: "Change or cancel your plan",
      body: "Open {{nav_billing}} and choose {{b_plan}}.",
    },
  ],
};

export const TOKEN = /\{\{(value:)?([\w.]+)\}\}/g;
export const CONDITION = /^\{\{(if|unless) pinned:([\w.]+)\}\}\s*/;
