// Questions people have asked (in feedback or in person). Answers use plain HTML-free text with
// paragraphs separated by blank lines; links are added in the template where needed.
export const FAQ = [
  {
    group: 'Security and data',
    items: [
      {
        q: 'How secure is this? Can we store sensitive client information here?',
        a: [
          'Everyone signs in with their own account, admins decide who gets in, deactivated people are signed out at once, projects can be limited to their members, and admin actions are recorded in an audit log. Traffic is encrypted (HTTPS) and the data is encrypted at rest by Cloudflare. Passwords, sessions and access tokens are stored only as one-way hashes.',
          'Please do not put client secrets (passwords, API keys, credentials), payment details or regulated personal data in it. Normal project information such as tasks, notes and status updates is fine.',
        ],
      },
      {
        q: 'Is there a backup in case something goes wrong?',
        a: [
          'Yes, in a few layers. A deleted issue goes to the Trash (in the sidebar) with its sub-tasks, comments, work log and files. Its reporter or a project admin can restore it there for 30 days (admins can change the number of days); after that it is removed for good. Deletions, restores and removals are in the audit log.',
          "Cloudflare's database restore (Time Travel) can roll the whole database back to any minute in the last 7 days, including attachments, which are stored in the same database. It is done on the Cloudflare account, not in the app, and undoes every change made since that minute.",
          'Admins can download a full backup (one JSON file) under Admin > Backups at any time, with the attached files if they want. It never contains passwords or access tokens.',
          'An automatic daily copy to a second location (a webhook or a Google Cloud Storage bucket) runs only once an admin has set one up on the server. It is not set up by default; Admin > Backups shows whether it is and how the last copy went.',
          'A copy can also be committed to a private GitHub repository every 6 hours, once the server has the repository and a token for it. Each commit is a version, and the whole workspace (projects, issues, settings) can be restored from it after a server crash.',
        ],
      },
      {
        q: 'Where is our data stored?',
        a: [
          'In the database of the deployment your admin chose: Cloudflare D1, or Postgres (for example Cloud SQL on Google Cloud). Slack, email and AI assistants only receive what you send them: a Slack message for a channel update, an email for a notification, or the issues an AI assistant asks for on your behalf.',
        ],
      },
      {
        q: 'Who can see my project and issues?',
        a: [
          'A project open to everyone can be read and edited by every member. A members-only project is visible only to its members and to admins. Viewers can read but not change anything. Guests (clients) see only the projects they were added to, open or not. See Roles and what they can do above.',
        ],
      },
      {
        q: 'Can we invite a client to follow their project?',
        a: [
          'Yes. An admin adds them under Admin > Users with the role Guest. A guest sees nothing until a project admin adds them under Project settings > Members, with one of three levels: read only, can comment (also add files to comments and watch issues) or can create and edit own (also create issues and change the issues they reported).',
          'Guests never see open projects they are not in, other people in the workspace, AI connectors, API tokens or the Trash. They cannot delete issues, manage sprints or change settings.',
        ],
      },
      {
        q: 'How do I write something the client should not see?',
        a: [
          'Tick Internal note under the comment box before you post. Internal notes have an Internal badge; guests never see them, their files or notifications about them. Everything else on an issue (title, description, fields, ordinary comments, history) is visible to guests in that project, so keep internal discussion in internal notes.',
        ],
      },
      {
        q: 'Is my text sent to an AI service?',
        a: [
          "Enhance with AI runs Chrome's built-in model on your own computer; nothing leaves it. AI assistants such as Claude or ChatGPT only see the tracker when you connect them yourself, and then only what you could see anyway. You can revoke them on the AI connectors page.",
          'Channel AI sessions are the exception: when a project admin turns one on for a Slack channel linked to an issue, that issue and the new channel messages are sent to the AI provider set up on the server. See the next question.',
        ],
      },
      {
        q: 'What does the AI see in a channel AI session?',
        a: [
          'Every 30 minutes (or when a project admin clicks Run now) the tracker sends the AI provider: the issue key, title, type, status and the list of statuses, priority, assignee, due date, description and the last five comments (internal notes included), the names of the project members, the who-is-who notes, whether the channel is internal or external, and the Slack messages posted since the last run: author names, times and text. The first run of a whole channel reads up to the last 7 days; a linked thread is read from its first message.',
          'Messages from bots and join or leave notices are left out. Direct messages are never read. The tracker does not store the Slack messages: it keeps only the AI note (an internal comment that guests never see) and the suggested changes. Nothing is ever posted back to Slack.',
          'The AI provider is the one an admin set on the server (for example Gemini on Google Cloud, in the same company account the tracker moves to). Sessions are off until a workspace admin allows them, and external channels (shared with the client) need a second, separate switch, because client messages would then be sent to the provider too.',
          'The AI can be wrong. Status, assignee, due date and priority changes always wait for a person to click Apply; only notes and sub-tasks can be added without asking, and only when a project admin turns that on for the link.',
        ],
      },
    ],
  },
  {
    group: 'Working with the tracker',
    items: [
      {
        q: 'Can we connect this to a Google Sheet, for example a project plan with epic and story IDs and assignees?',
        a: [
          'Yes. Open Issues, filter to what you need (for example one project), choose Google Sheets feed, pick the columns (key, type, epic, assignee and more) and copy the =IMPORTDATA formula into cell A1 of a sheet. Google refreshes it about every hour.',
          'Anyone who has that link can read the data, so keep the sheet private and revoke the feed when you no longer need it. The feed only ever shows what you yourself can see.',
        ],
      },
      {
        q: 'Can I attach files?',
        a: [
          'Yes. Use Add attachment on an issue, drop files onto the issue, or paste a screenshot straight into the description or a comment. Files can be up to 10 MB each, with up to 50 per issue.',
        ],
      },
      {
        q: 'How do I tag someone?',
        a: [
          'Type @ and the first letters of their name in a description or comment, then pick them from the list. You see @Name; they get a notification.',
        ],
      },
      {
        q: 'I tagged someone. Why did they not get a notification?',
        a: [
          'They get an in-app notification (the bell) straight away. You never get one for your own actions, so tagging yourself does nothing.',
          'Slack messages need Slack to be connected (Admin > Slack). Email needs an email service set up on the server; once it is, assignments and mentions are emailed by default and each person can change that under Profile.',
        ],
      },
      {
        q: 'Will I be reminded about due dates? What is the weekly digest?',
        a: [
          'Yes. Once a day (08:00 by default) you get one message listing your open issues that are overdue or due today or tomorrow. Every Monday you get a weekly digest: your open issues by status, what is due this week, issues you watch that others changed, and your mentions. Both show under the bell, and also come by Slack and email when those are set up. Turn the Slack or email copies off under Profile. The digest page shows yours at any time.',
          'Admins set the time zone, times and day under Admin > Settings > Scheduled jobs. The jobs run when someone uses the app after that time, so they can start a few minutes late.',
        ],
      },
      {
        q: 'Can we import our Jira issues or a spreadsheet?',
        a: [
          'Yes. In a project, open Backlog and choose Import issues. Paste or upload a CSV (a Jira CSV export works), check the column mapping and the preview, then import up to 500 issues at a time.',
        ],
      },
      {
        q: 'Can I use Claude, ChatGPT or Copilot with it?',
        a: ['Yes, through the MCP server. See AI assistants above and the AI connectors page for the steps for each app.'],
      },
      {
        q: 'Does it work on my phone?',
        a: [
          'Yes. The menu moves behind the button at the top left, boards scroll sideways one column at a time, and everything else works the same.',
        ],
      },
      {
        q: 'I forgot my password. What now?',
        a: [
          'Ask an admin. They can send you a new link to set a password (Admin > Users > Reset link). If Google sign-in is turned on, use that instead.',
        ],
      },
      {
        q: 'How do I change my name or add a photo?',
        a: [
          'Open your name at the bottom of the menu and choose Profile. You can upload a photo there; it replaces your initials everywhere.',
        ],
      },
      {
        q: 'How do I suggest a feature or report a problem?',
        a: [
          'Use Feedback in the menu. Capture this page adds a screenshot, and the technical details help find the cause. You can follow what happens to it under Your earlier feedback.',
        ],
      },
    ],
  },
];
