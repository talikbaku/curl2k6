# Privacy

curl2k6 collects no data. It has no servers, no telemetry and no analytics.

- Everything runs on your machine or in your own CI: the scripts read and write files in your repository, and k6 sends load only to the API you point it at.
- Reports go only where you tell Claude to put them (a markdown file in your repo, your team wiki).
- Tokens stay in your environment variables or CI secrets; the plugin refers to them by name and never stores, prints or transmits their values anywhere except to the API under test, as part of the load test you configured.

What Claude itself does with your conversation is covered by Anthropic's privacy policy, not by this plugin.

Questions: [open an issue](https://github.com/talikbaku/curl2k6/issues).
