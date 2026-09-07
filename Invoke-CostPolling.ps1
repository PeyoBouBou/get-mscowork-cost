[CmdletBinding()]
param(
    [uri]$Url = 'https://mcsaetherruntime-eus.us-ia106.gateway.prod.island.powerapps.com/v1/cost',

    [ValidateRange(1, 86400)]
    [int]$IntervalSeconds = 30,

    [string]$TokenFile = (Join-Path $PSScriptRoot 'bearer-token.txt'),

    [string]$OutputFile,

    [string]$BearerToken,

    [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSEdition -eq 'Desktop') {
    Add-Type -AssemblyName System.Net.Http
}

$script:StartTime = Get-Date
$script:SeparatorHandled = $false

$ScriptColor = 'Cyan'
$ResponseColor = 'Green'
$SeparatorColor = 'DarkGray'

function Write-ScriptMessage {
    param(
        [Parameter(Mandatory)][string]$Message,
        [string]$Color = $ScriptColor
    )

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-Host "[$timestamp] $Message" -ForegroundColor $Color
}

function Resolve-FullPath {
    param([Parameter(Mandatory)][string]$Path)

    return [System.IO.Path]::GetFullPath(
        [System.IO.Path]::Combine((Get-Location).ProviderPath, $Path)
    )
}

function Confirm-ParentDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $directory = [System.IO.Path]::GetDirectoryName($Path)
    if (-not [string]::IsNullOrWhiteSpace($directory) -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
}

function Resolve-OutputFile {
    if (-not [string]::IsNullOrWhiteSpace($OutputFile)) {
        $path = $OutputFile
    }
    else {
        $path = Join-Path $PSScriptRoot ('cost-results-{0:yyyy-MM-dd}.json' -f $script:StartTime)
    }

    $fullPath = Resolve-FullPath -Path $path
    Confirm-ParentDirectory -Path $fullPath

    return $fullPath
}

function Request-BearerTokenFromUser {
    if (-not [Environment]::UserInteractive) {
        throw "Aucun jeton disponible et la session n'est pas interactive. Utilisez -BearerToken ou COST_API_BEARER_TOKEN."
    }

    Write-ScriptMessage "Aucun jeton valide trouve dans '$TokenFile'." 'Yellow'
    $secure = Read-Host -Prompt 'Entrez le jeton Bearer' -AsSecureString
    $entered = [System.Net.NetworkCredential]::new('', $secure).Password

    $entered = ($entered -replace '^\s*Bearer\s+', '').Trim()
    if ([string]::IsNullOrWhiteSpace($entered)) {
        throw 'Aucun jeton saisi.'
    }

    $tokenPath = Resolve-FullPath -Path $TokenFile
    Confirm-ParentDirectory -Path $tokenPath
    [System.IO.File]::WriteAllText($tokenPath, $entered, [System.Text.UTF8Encoding]::new($false))
    Write-ScriptMessage "Jeton enregistre dans '$tokenPath'."

    return $entered
}

function Get-CurrentBearerToken {
    $token = $null

    if (-not [string]::IsNullOrWhiteSpace($BearerToken)) {
        $token = $BearerToken
    }
    elseif (Test-Path -LiteralPath $TokenFile -PathType Leaf) {
        $token = Get-Content -LiteralPath $TokenFile -Raw
    }
    elseif (-not [string]::IsNullOrWhiteSpace($env:COST_API_BEARER_TOKEN)) {
        $token = $env:COST_API_BEARER_TOKEN
    }

    if (-not [string]::IsNullOrWhiteSpace($token)) {
        $token = ($token -replace '^\s*Bearer\s+', '').Trim()
    }

    if ([string]::IsNullOrWhiteSpace($token)) {
        return Request-BearerTokenFromUser
    }

    return $token
}

function Add-ResponseToFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Json
    )

    $encoding = [System.Text.UTF8Encoding]::new($false)
    $newLine = [System.Environment]::NewLine

    if (-not $script:SeparatorHandled) {
        $script:SeparatorHandled = $true

        $fileHasContent = (Test-Path -LiteralPath $Path -PathType Leaf) -and
                          ((Get-Item -LiteralPath $Path).Length -gt 0)

        if ($fileHasContent) {
            $separator = '--- {0:yyyy-MM-dd HH:mm:ss} ---' -f $script:StartTime
            [System.IO.File]::AppendAllText($Path, $separator + $newLine, $encoding)
            Write-Host $separator -ForegroundColor $SeparatorColor
        }
    }

    [System.IO.File]::AppendAllText($Path, $Json + $newLine, $encoding)
}

$outputPath = Resolve-OutputFile
Write-ScriptMessage "Fichier de sortie : '$outputPath'"
Write-ScriptMessage "Appel GET sur '$Url'"

$httpClient = [System.Net.Http.HttpClient]::new()
$httpClient.Timeout = [TimeSpan]::FromSeconds(60)
$exitCode = 0

try {
    do {
        $request = $null
        $response = $null

        try {
            $token = Get-CurrentBearerToken
            $request = [System.Net.Http.HttpRequestMessage]::new(
                [System.Net.Http.HttpMethod]::Get,
                $Url
            )
            $request.Headers.Authorization =
                [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token)

            $response = $httpClient.SendAsync($request).GetAwaiter().GetResult()
            $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            $statusCode = [int]$response.StatusCode

            if ($statusCode -ne 200) {
                Write-ScriptMessage "HTTP $statusCode ($($response.ReasonPhrase)) - arret du script." 'Red'
                if (-not [string]::IsNullOrWhiteSpace($body)) {
                    Write-Host $body -ForegroundColor 'Red'
                }

                $exitCode = 1
                break
            }

            if ([string]::IsNullOrWhiteSpace($body)) {
                throw "La reponse HTTP $statusCode est vide."
            }

            $parsedJson = $body | ConvertFrom-Json
            $jsonLine = $parsedJson | ConvertTo-Json -Compress -Depth 100

            Add-ResponseToFile -Path $outputPath -Json $jsonLine
            Write-Host $jsonLine -ForegroundColor $ResponseColor
            Write-ScriptMessage "HTTP $statusCode - JSON ajoute dans '$outputPath'"
        }
        catch {
            Write-ScriptMessage "Echec de l'appel : $($_.Exception.Message)" 'Red'
        }
        finally {
            if ($null -ne $response) {
                $response.Dispose()
            }
            if ($null -ne $request) {
                $request.Dispose()
            }
        }

        if (-not $Once) {
            Start-Sleep -Seconds $IntervalSeconds
        }
    } while (-not $Once)
}
finally {
    $httpClient.Dispose()
}

exit $exitCode
