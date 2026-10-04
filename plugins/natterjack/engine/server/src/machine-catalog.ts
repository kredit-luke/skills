/**
 * The Machine page's check catalog: common tools with how to detect them and how
 * to install them per OS. machine.json picks entries by id ({ "use": "go" }) and
 * overrides any field (group, label, apps, required, install, detail, ...), or
 * defines a check from scratch with a `kind`.
 *
 * Kinds (the probe logic lives in machine.ts):
 *   command            run probe.cmd probe.args; version from the output; optional
 *                      auth probe (installed but signed out = warn)
 *   node               Node.js, with nvm awareness (an old default rescued by nvm = warn)
 *   dotnet-sdk         a .NET SDK of the required major version
 *   dotnet-dev-cert    the trusted HTTPS dev certificate
 *   dotnet-user-secrets  a project's secrets.json (never installed: from a teammate)
 *   docker             Docker installed and the engine running
 *   docker-container   a named container running and answering on its host port
 *   path               a file or folder exists in the workspace (e.g. node_modules)
 *   npm-global         a globally installed npm package
 *   env-var            an environment variable is set
 *   port               something answers on a local port
 *   package-manager    winget (Windows) / Homebrew (macOS), which the Install buttons use
 *   claude-connector   a claude.ai connector (`connector`: its name, e.g. "Atlassian") connected
 *                      for this person, from `claude mcp list`; the button opens claude.ai's connectors
 *   claude-code        Claude Code installed and signed in (`claude auth status`); Sign in
 *                      opens a terminal running `claude auth login`
 *
 * Install commands are per OS ({ win, mac, linux }; null = nothing to run there).
 * In a command, {required} is the required version and {major} its major number.
 * Only commands defined here or in machine.json can ever run: the browser sends a
 * check id, never command text. Windows ids are winget ids; leave one null rather
 * than guess, and give `fix` text instead.
 */

export type OsStr = string | { win?: string | null; mac?: string | null; linux?: string | null };
export interface Install { label?: string; win?: string | null; mac?: string | null; linux?: string | null; cwd?: string }
export interface CatalogEntry {
  kind: string;
  label: string;
  group?: string;
  probe?: { cmd: OsStr; args: string[]; stream?: "out" | "err" | "both" };
  auth?: { cmd: string; args: string[]; signIn: Install; detail?: string };
  install?: Install;
  fix?: OsStr;
  detail?: { ok?: string; missing?: string };
}

const cmd = (c: OsStr, args: string[], stream?: "out" | "err" | "both") => ({ cmd: c, args, stream });

export const CATALOG: Record<string, CatalogEntry> = {
  "package-manager": { kind: "package-manager", label: "Package manager" },

  // ---- runtimes
  node: { kind: "node", label: "Node.js" },
  npm: { kind: "command", label: "npm", probe: cmd("npm", ["-v"]), fix: "Installed with Node.js", detail: { missing: "Comes with Node.js; install Node above." } },
  pnpm: { kind: "command", label: "pnpm", probe: cmd("pnpm", ["-v"]), install: { win: "npm install -g pnpm", mac: "npm install -g pnpm", linux: "npm install -g pnpm" } },
  yarn: { kind: "command", label: "Yarn", probe: cmd("yarn", ["-v"]), install: { win: "npm install -g yarn", mac: "npm install -g yarn", linux: "npm install -g yarn" } },
  bun: { kind: "command", label: "Bun", probe: cmd("bun", ["-v"]), install: { win: "powershell -c \"irm bun.sh/install.ps1 | iex\"", mac: "brew install oven-sh/bun/bun", linux: "curl -fsSL https://bun.sh/install | bash" } },
  python: { kind: "command", label: "Python 3", probe: cmd({ win: "python", mac: "python3", linux: "python3" }, ["--version"], "both"), install: { win: "winget install --id Python.Python.3.12 -e", mac: "brew install python", linux: "sudo apt-get install -y python3" } },
  uv: { kind: "command", label: "uv", probe: cmd("uv", ["--version"]), install: { win: "powershell -c \"irm https://astral.sh/uv/install.ps1 | iex\"", mac: "brew install uv", linux: "curl -LsSf https://astral.sh/uv/install.sh | sh" } },
  php: { kind: "command", label: "PHP", probe: cmd("php", ["-v"]), install: { win: null, mac: "brew install php", linux: "sudo apt-get install -y php-cli" }, fix: { win: "Install PHP from https://windows.php.net/download and add it to PATH" } },
  composer: { kind: "command", label: "Composer", probe: cmd("composer", ["--version"]), install: { win: null, mac: "brew install composer", linux: "sudo apt-get install -y composer" }, fix: { win: "Install Composer from https://getcomposer.org/download/" } },
  go: { kind: "command", label: "Go", probe: cmd("go", ["version"]), install: { win: "winget install --id GoLang.Go -e", mac: "brew install go", linux: "sudo apt-get install -y golang-go" } },
  java: { kind: "command", label: "Java (JDK)", probe: cmd("java", ["-version"], "both"), install: { win: "winget install --id Microsoft.OpenJDK.21 -e", mac: "brew install openjdk", linux: "sudo apt-get install -y openjdk-21-jdk" } },
  maven: { kind: "command", label: "Maven", probe: cmd("mvn", ["-v"]), install: { win: null, mac: "brew install maven", linux: "sudo apt-get install -y maven" }, fix: { win: "Install Maven from https://maven.apache.org/download.cgi" } },
  gradle: { kind: "command", label: "Gradle", probe: cmd("gradle", ["-v"]), install: { win: null, mac: "brew install gradle", linux: "sudo apt-get install -y gradle" }, fix: { win: "Install Gradle from https://gradle.org/install/" } },
  ruby: { kind: "command", label: "Ruby", probe: cmd("ruby", ["-v"]), install: { win: null, mac: "brew install ruby", linux: "sudo apt-get install -y ruby-full" }, fix: { win: "Install Ruby from https://rubyinstaller.org/" } },
  bundler: { kind: "command", label: "Bundler", probe: cmd("bundle", ["-v"]), install: { win: "gem install bundler", mac: "gem install bundler", linux: "gem install bundler" } },
  cargo: { kind: "command", label: "Rust (cargo)", probe: cmd("cargo", ["--version"]), install: { win: "winget install --id Rustlang.Rustup -e", mac: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh", linux: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" } },
  dotnet: { kind: "dotnet-sdk", label: ".NET SDK" },
  "dotnet-dev-cert": { kind: "dotnet-dev-cert", label: "HTTPS dev certificate" },
  "dotnet-user-secrets": { kind: "dotnet-user-secrets", label: "User secrets" },

  // ---- source control, CLIs
  git: { kind: "command", label: "Git", probe: cmd("git", ["--version"]), install: { win: "winget install --id Git.Git -e", mac: "xcode-select --install", linux: "sudo apt-get install -y git" } },
  gh: {
    kind: "command", label: "GitHub CLI", probe: cmd("gh", ["--version"]),
    detail: { missing: "Used for cloning, PRs and the Needs-you inbox.", ok: "Signed in." },
    install: { win: "winget install --id GitHub.cli -e", mac: "brew install gh", linux: "sudo apt-get install -y gh" },
    auth: { cmd: "gh", args: ["auth", "status"], detail: "Installed but not signed in.", signIn: { label: "Sign in", win: "gh auth login; gh auth setup-git", mac: "gh auth login && gh auth setup-git", linux: "gh auth login && gh auth setup-git" } },
  },
  glab: {
    kind: "command", label: "GitLab CLI", probe: cmd("glab", ["--version"]),
    detail: { missing: "Used for merge requests and CI status.", ok: "Signed in." },
    install: { win: null, mac: "brew install glab", linux: null }, fix: "Install glab from https://gitlab.com/gitlab-org/cli#installation",
    auth: { cmd: "glab", args: ["auth", "status"], detail: "Installed but not signed in.", signIn: { label: "Sign in", win: "glab auth login", mac: "glab auth login", linux: "glab auth login" } },
  },
  claude: {
    kind: "claude-code", label: "Claude Code", probe: cmd("claude", ["--version"]),
    detail: { missing: "The dashboard's runs, usage meters and autocomplete all use it. Sign in once it's installed." },
    install: { win: "irm https://claude.ai/install.ps1 | iex", mac: "curl -fsSL https://claude.ai/install.sh | bash", linux: "curl -fsSL https://claude.ai/install.sh | bash" },
  },
  copilot: {
    kind: "agent-cli", label: "GitHub Copilot CLI",
    detail: { missing: "Lets dashboard runs use Copilot (the Agent picker in Ask and Run). Sign in with `copilot login` once it's installed.", ok: "Installed: pick Copilot as the agent in Ask or Run." },
    install: { win: "winget install --id GitHub.Copilot -e", mac: "brew install copilot-cli", linux: "npm install -g @github/copilot" },
  },
  codex: {
    kind: "agent-cli", label: "OpenAI Codex CLI",
    detail: { missing: "Lets dashboard runs use Codex (the Agent picker in Ask and Run).", ok: "Signed in: pick Codex as the agent in Ask or Run." },
    install: { win: "npm install -g @openai/codex", mac: "npm install -g @openai/codex", linux: "npm install -g @openai/codex" },
  },
  ollama: {
    kind: "command", label: "Ollama", probe: cmd("ollama", ["--version"], "both"),
    detail: { missing: "Runs open models on this computer (the Models page downloads them and lets runs use them).", ok: "Runs open models on this computer: see the Models page." },
    install: { win: "winget install --id Ollama.Ollama -e", mac: "brew install ollama", linux: "curl -fsSL https://ollama.com/install.sh | sh" },
  },
  "claude-connector": {
    kind: "claude-connector", label: "claude.ai connector",
    install: { label: "Open claude.ai", win: "Start-Process https://claude.ai/settings/connectors", mac: "open https://claude.ai/settings/connectors", linux: "xdg-open https://claude.ai/settings/connectors" },
  },
  curl: { kind: "command", label: "curl", probe: cmd("curl", ["--version"]), fix: { win: "Ships with Windows 10+ (curl.exe)", mac: "Ships with macOS", linux: "sudo apt-get install -y curl" } },
  az: { kind: "command", label: "Azure CLI", probe: cmd("az", ["--version"]), install: { win: "winget install --id Microsoft.AzureCLI -e", mac: "brew install azure-cli", linux: null }, fix: { linux: "See https://learn.microsoft.com/cli/azure/install-azure-cli-linux" } },
  aws: { kind: "command", label: "AWS CLI", probe: cmd("aws", ["--version"], "both"), install: { win: "winget install --id Amazon.AWSCLI -e", mac: "brew install awscli", linux: null }, fix: { linux: "See https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" } },
  gcloud: { kind: "command", label: "Google Cloud CLI", probe: cmd("gcloud", ["--version"]), install: { win: null, mac: "brew install --cask google-cloud-sdk", linux: null }, fix: "See https://cloud.google.com/sdk/docs/install" },
  terraform: { kind: "command", label: "Terraform", probe: cmd("terraform", ["-version"]), install: { win: "winget install --id Hashicorp.Terraform -e", mac: "brew install terraform", linux: null }, fix: { linux: "See https://developer.hashicorp.com/terraform/install" } },
  kubectl: { kind: "command", label: "kubectl", probe: cmd("kubectl", ["version", "--client"]), install: { win: "winget install --id Kubernetes.kubectl -e", mac: "brew install kubectl", linux: null }, fix: { linux: "See https://kubernetes.io/docs/tasks/tools/" } },

  // ---- databases and containers
  docker: { kind: "docker", label: "Docker" },
  "docker-container": { kind: "docker-container", label: "Container" },
  psql: { kind: "command", label: "psql (PostgreSQL client)", probe: cmd("psql", ["--version"]), install: { win: null, mac: "brew install libpq", linux: "sudo apt-get install -y postgresql-client" }, fix: { win: "Install the PostgreSQL client from https://www.postgresql.org/download/windows/" } },
  mysql: { kind: "command", label: "mysql (MySQL client)", probe: cmd("mysql", ["--version"]), install: { win: null, mac: "brew install mysql-client", linux: "sudo apt-get install -y mysql-client" }, fix: { win: "Install MySQL Shell/client from https://dev.mysql.com/downloads/" } },
  "redis-cli": { kind: "command", label: "redis-cli", probe: cmd("redis-cli", ["--version"]), install: { win: null, mac: "brew install redis", linux: "sudo apt-get install -y redis-tools" } },

  // ---- generic
  path: { kind: "path", label: "Path" },
  "npm-global": { kind: "npm-global", label: "npm package (global)" },
  "env-var": { kind: "env-var", label: "Environment variable" },
  port: { kind: "port", label: "Port" },
};
