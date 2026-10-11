# The tool server's (mcpo) config: tools\mcpo-config.json, plus the tools added from Prestige's tool store
# (data\mcpo-extra.json, which stays on this PC: it can hold API keys). Both use {ROOT} and {HOME}. Written to
# data\runtime\mcpo-config.json by start-all.ps1 and update-tools.ps1; mcpo runs with --hot-reload, so a change to
# the added tools applies while it runs.

function Expand-ToolJson([string]$text, [string]$Root) {
    $text.Replace('{ROOT}', $Root.Replace('\', '\\')).Replace('{HOME}', $env:USERPROFILE.Replace('\', '\\'))
}

function Write-ToolConfig([string]$Root, [string]$Runtime) {
    $base = Expand-ToolJson (Get-Content -Raw "$Root\tools\mcpo-config.json") $Root | ConvertFrom-Json
    $extraFile = Join-Path $Root "data\mcpo-extra.json"
    if (Test-Path $extraFile) {
        try {
            $extra = Expand-ToolJson (Get-Content -Raw $extraFile) $Root | ConvertFrom-Json
            foreach ($s in @($extra.mcpServers.PSObject.Properties)) {
                # The built-in servers keep their names; an added tool can't replace one.
                if ($base.mcpServers.PSObject.Properties[$s.Name]) { Write-Warning "tool store: '$($s.Name)' is a built-in tool server name, skipped"; continue }
                $base.mcpServers | Add-Member -NotePropertyName $s.Name -NotePropertyValue $s.Value -Force
            }
        } catch {
            Write-Warning "data\mcpo-extra.json couldn't be read, so the added tools are left out: $_"
        }
    }
    New-Item -ItemType Directory -Force $Runtime | Out-Null
    [IO.File]::WriteAllText("$Runtime\mcpo-config.json", ($base | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
}

# The command line start-all.ps1 starts mcpo with.
function Get-McpoArgs([string]$Runtime) {
    "--host 127.0.0.1 --port 8200 --config `"$Runtime\mcpo-config.json`" --hot-reload"
}
