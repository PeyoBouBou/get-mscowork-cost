[CmdletBinding()]
param(
    [uri]$Url = 'https://mcsaetherruntime-eus.us-ia106.gateway.prod.island.powerapps.com/v1/cost',

    [ValidateRange(1, 86400)]
    [int]$IntervalSeconds = 30,

    [string]$TokenFile = (Join-Path $PSScriptRoot 'bearer-token.txt'),

    [string]$TokenCacheFile = (Join-Path $PSScriptRoot 'token-cache.json'),

    [string]$OutputFile,

    [string]$BearerToken,

    [string]$TenantId = 'organizations',

    [string]$Authority = 'https://login.microsoftonline.com',

    [string]$ClientId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46',

    [string]$Scope = '96ff4394-9197-43aa-b393-6a41652e21f8/.default',

    [switch]$Login,

    [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSEdition -eq 'Desktop') {
    Add-Type -AssemblyName System.Net.Http
}

$script:StartTime = Get-Date
$script:SeparatorHandled = $false
$script:TokenInfo = $null

$ScriptColor = 'Cyan'
$ResponseColor = 'Green'
$SeparatorColor = 'DarkGray'
$AuthColor = 'Yellow'

$AuthorityBase = "$($Authority.TrimEnd('/'))/$TenantId/oauth2/v2.0"

function Write-ScriptMessage {
    param(
        [Parameter(Mandatory)][string]$Message,
        [string]$Color = $ScriptColor
    )

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-Host "[$timestamp] $Message" -ForegroundColor $Color
}

function Get-Prop {
    param($Object, [Parameter(Mandatory)][string]$Name)

    if ($null -eq $Object) { return $null }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
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

function ConvertFrom-JwtPayload {
    param([Parameter(Mandatory)][string]$Token)

    try {
        $parts = $Token.Split('.')
        if ($parts.Count -lt 2) { return $null }

        $segment = $parts[1].Replace('-', '+').Replace('_', '/')
        switch ($segment.Length % 4) {
            2 { $segment += '==' }
            3 { $segment += '=' }
        }

        $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($segment))
        return $json | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Get-TokenExpiry {
    param([Parameter(Mandatory)][string]$Token)

    $payload = ConvertFrom-JwtPayload -Token $Token
    $exp = Get-Prop $payload 'exp'
    if ($null -eq $exp) { return $null }

    return [System.DateTimeOffset]::FromUnixTimeSeconds([long]$exp).UtcDateTime
}

function Test-TokenUsable {
    param($Info, [int]$MarginSeconds = 120)

    $token = Get-Prop $Info 'AccessToken'
    if ([string]::IsNullOrWhiteSpace($token)) { return $false }

    $expiry = Get-TokenExpiry -Token $token
    if ($null -eq $expiry) { return $true }

    return $expiry -gt (Get-Date).ToUniversalTime().AddSeconds($MarginSeconds)
}

function Protect-Secret {
    param([Parameter(Mandatory)][string]$Value)

    return ConvertTo-SecureString $Value -AsPlainText -Force | ConvertFrom-SecureString
}

function Unprotect-Secret {
    param([Parameter(Mandatory)][string]$Value)

    $secure = ConvertTo-SecureString $Value
    return [System.Net.NetworkCredential]::new('', $secure).Password
}

function Read-TokenCache {
    $path = Resolve-FullPath -Path $TokenCacheFile
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }

    try {
        $raw = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json

        $cachedScope = Get-Prop $raw 'Scope'
        $cachedClient = Get-Prop $raw 'ClientId'
        if ($cachedScope -ne $Scope -or $cachedClient -ne $ClientId) {
            Write-ScriptMessage 'Cache de jeton ignore : client ou scope different.' $AuthColor
            return $null
        }

        $info = [pscustomobject]@{
            AccessToken  = $null
            RefreshToken = $null
        }

        $access = Get-Prop $raw 'AccessToken'
        if (-not [string]::IsNullOrWhiteSpace($access)) {
            $info.AccessToken = Unprotect-Secret -Value $access
        }

        $refresh = Get-Prop $raw 'RefreshToken'
        if (-not [string]::IsNullOrWhiteSpace($refresh)) {
            $info.RefreshToken = Unprotect-Secret -Value $refresh
        }

        return $info
    }
    catch {
        Write-ScriptMessage "Cache de jeton illisible, il sera recree : $($_.Exception.Message)" $AuthColor
        return $null
    }
}

function Write-TokenCache {
    param([Parameter(Mandatory)]$Info)

    $path = Resolve-FullPath -Path $TokenCacheFile
    Confirm-ParentDirectory -Path $path

    $payload = [ordered]@{
        ClientId     = $ClientId
        Scope        = $Scope
        TenantId     = $TenantId
        SavedAtUtc   = (Get-Date).ToUniversalTime().ToString('o')
        AccessToken  = $null
        RefreshToken = $null
    }

    $access = Get-Prop $Info 'AccessToken'
    if (-not [string]::IsNullOrWhiteSpace($access)) {
        $payload.AccessToken = Protect-Secret -Value $access
    }

    $refresh = Get-Prop $Info 'RefreshToken'
    if (-not [string]::IsNullOrWhiteSpace($refresh)) {
        $payload.RefreshToken = Protect-Secret -Value $refresh
    }

    $json = [pscustomobject]$payload | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Save-BearerTokenFile {
    param([Parameter(Mandatory)][string]$Token)

    $path = Resolve-FullPath -Path $TokenFile
    Confirm-ParentDirectory -Path $path
    [System.IO.File]::WriteAllText($path, $Token, [System.Text.UTF8Encoding]::new($false))
}

function Get-OAuthErrorCode {
    param($ErrorRecord)

    $details = $null
    if ($null -ne $ErrorRecord.ErrorDetails) {
        $details = $ErrorRecord.ErrorDetails.Message
    }

    if ([string]::IsNullOrWhiteSpace($details)) {
        try {
            $stream = $ErrorRecord.Exception.Response.GetResponseStream()
            $details = [System.IO.StreamReader]::new($stream).ReadToEnd()
        }
        catch { }
    }

    if ([string]::IsNullOrWhiteSpace($details)) { return $null }

    try {
        return ($details | ConvertFrom-Json)
    }
    catch {
        return [pscustomobject]@{ error = 'unknown'; error_description = $details }
    }
}

function New-TokenInfo {
    param([Parameter(Mandatory)]$Response, $PreviousRefreshToken)

    $refresh = Get-Prop $Response 'refresh_token'
    if ([string]::IsNullOrWhiteSpace($refresh)) {
        $refresh = $PreviousRefreshToken
    }

    return [pscustomobject]@{
        AccessToken  = Get-Prop $Response 'access_token'
        RefreshToken = $refresh
    }
}

function Invoke-TokenRefresh {
    param([Parameter(Mandatory)][string]$RefreshToken)

    Write-ScriptMessage 'Renouvellement silencieux du jeton (refresh_token)...' $AuthColor

    $body = @{
        client_id     = $ClientId
        scope         = "$Scope offline_access"
        grant_type    = 'refresh_token'
        refresh_token = $RefreshToken
    }

    try {
        $response = Invoke-RestMethod -Method Post -Uri "$AuthorityBase/token" -Body $body -ErrorAction Stop
        Write-ScriptMessage 'Jeton renouvele sans interaction.' $AuthColor
        return New-TokenInfo -Response $response -PreviousRefreshToken $RefreshToken
    }
    catch {
        $err = Get-OAuthErrorCode -ErrorRecord $_
        $code = Get-Prop $err 'error'
        Write-ScriptMessage "Renouvellement silencieux impossible ($code)." $AuthColor
        return $null
    }
}

function Invoke-DeviceCodeFlow {
    if (-not [Environment]::UserInteractive) {
        throw 'Connexion interactive requise mais la session ne l est pas. Utilisez -BearerToken.'
    }

    $body = @{
        client_id = $ClientId
        scope     = "$Scope offline_access"
    }

    $device = Invoke-RestMethod -Method Post -Uri "$AuthorityBase/devicecode" -Body $body -ErrorAction Stop

    Write-Host ''
    Write-Host '  ---------------------------------------------------------------' -ForegroundColor $AuthColor
    Write-Host '   Connexion Microsoft 365 requise' -ForegroundColor $AuthColor
    Write-Host "   1. Ouvrez : $(Get-Prop $device 'verification_uri')" -ForegroundColor $AuthColor
    Write-Host "   2. Code   : $(Get-Prop $device 'user_code')" -ForegroundColor $AuthColor
    Write-Host '  ---------------------------------------------------------------' -ForegroundColor $AuthColor
    Write-Host ''

    $interval = [int](Get-Prop $device 'interval')
    if ($interval -le 0) { $interval = 5 }

    $deadline = (Get-Date).AddSeconds([int](Get-Prop $device 'expires_in'))
    $pollBody = @{
        client_id   = $ClientId
        grant_type  = 'urn:ietf:params:oauth:grant-type:device_code'
        device_code = Get-Prop $device 'device_code'
    }

    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds $interval

        try {
            $response = Invoke-RestMethod -Method Post -Uri "$AuthorityBase/token" -Body $pollBody -ErrorAction Stop
            Write-ScriptMessage 'Connexion reussie.' $AuthColor
            return New-TokenInfo -Response $response -PreviousRefreshToken $null
        }
        catch {
            $err = Get-OAuthErrorCode -ErrorRecord $_
            $code = Get-Prop $err 'error'

            switch ($code) {
                'authorization_pending' { continue }
                'slow_down' { $interval += 5; continue }
                default {
                    $desc = Get-Prop $err 'error_description'
                    if ([string]::IsNullOrWhiteSpace($desc)) { $desc = $code }
                    throw "Echec de la connexion ($code) : $desc"
                }
            }
        }
    }

    throw 'Delai de connexion depasse : le code de verification a expire.'
}

function Get-AccessToken {
    param([switch]$ForceRenew)

    if (-not $ForceRenew) {
        if (-not [string]::IsNullOrWhiteSpace($BearerToken)) {
            $manual = ($BearerToken -replace '^\s*Bearer\s+', '').Trim()
            $script:TokenInfo = [pscustomobject]@{ AccessToken = $manual; RefreshToken = $null }
            return $manual
        }

        if (Test-TokenUsable -Info $script:TokenInfo) {
            return $script:TokenInfo.AccessToken
        }

        if (-not $Login) {
            if (Test-Path -LiteralPath $TokenFile -PathType Leaf) {
                $fileToken = (Get-Content -LiteralPath $TokenFile -Raw) -replace '^\s*Bearer\s+', ''
                $fileToken = $fileToken.Trim()
                $candidate = [pscustomobject]@{ AccessToken = $fileToken; RefreshToken = $null }
                if (Test-TokenUsable -Info $candidate) {
                    Write-ScriptMessage "Jeton repris depuis '$TokenFile'."
                    $script:TokenInfo = $candidate
                    return $fileToken
                }
            }

            $cached = Read-TokenCache
            if ($null -ne $cached) {
                if (Test-TokenUsable -Info $cached) {
                    Write-ScriptMessage 'Jeton repris depuis le cache local.'
                    $script:TokenInfo = $cached
                    return $cached.AccessToken
                }

                $script:TokenInfo = $cached
            }
        }
    }

    $refreshToken = Get-Prop $script:TokenInfo 'RefreshToken'
    if ([string]::IsNullOrWhiteSpace($refreshToken)) {
        $cached = Read-TokenCache
        $refreshToken = Get-Prop $cached 'RefreshToken'
    }

    $renewed = $null
    if (-not [string]::IsNullOrWhiteSpace($refreshToken)) {
        $renewed = Invoke-TokenRefresh -RefreshToken $refreshToken
    }

    if ($null -eq $renewed) {
        $renewed = Invoke-DeviceCodeFlow
    }

    $script:TokenInfo = $renewed
    Write-TokenCache -Info $renewed
    Save-BearerTokenFile -Token $renewed.AccessToken

    $payload = ConvertFrom-JwtPayload -Token $renewed.AccessToken
    $upn = Get-Prop $payload 'upn'
    if ([string]::IsNullOrWhiteSpace($upn)) { $upn = Get-Prop $payload 'preferred_username' }
    $expiry = Get-TokenExpiry -Token $renewed.AccessToken

    $who = if ([string]::IsNullOrWhiteSpace($upn)) { 'compte inconnu' } else { $upn }
    $until = if ($null -eq $expiry) { 'expiration inconnue' } else { "valide jusqu a $($expiry.ToLocalTime().ToString('HH:mm:ss'))" }
    Write-ScriptMessage "Jeton obtenu pour $who ($until)." $AuthColor

    return $renewed.AccessToken
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

function Invoke-CostRequest {
    param(
        [Parameter(Mandatory)][System.Net.Http.HttpClient]$Client,
        [Parameter(Mandatory)][string]$Token
    )

    $request = [System.Net.Http.HttpRequestMessage]::new(
        [System.Net.Http.HttpMethod]::Get,
        $Url
    )

    try {
        $request.Headers.Authorization =
            [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Token)

        $payload = ConvertFrom-JwtPayload -Token $Token
        $tid = Get-Prop $payload 'tid'
        $oid = Get-Prop $payload 'oid'
        if (-not [string]::IsNullOrWhiteSpace($tid)) { $request.Headers.Add('x-tenant-id', $tid) }
        if (-not [string]::IsNullOrWhiteSpace($oid)) { $request.Headers.Add('x-user-id', $oid) }

        $response = $Client.SendAsync($request).GetAwaiter().GetResult()
        try {
            return [pscustomobject]@{
                StatusCode   = [int]$response.StatusCode
                ReasonPhrase = $response.ReasonPhrase
                Body         = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            }
        }
        finally {
            $response.Dispose()
        }
    }
    finally {
        $request.Dispose()
    }
}

function Show-UnauthorizedDetail {
    param([string]$Body)

    if ([string]::IsNullOrWhiteSpace($Body)) { return }

    try {
        $parsed = $Body | ConvertFrom-Json
        $code = Get-Prop $parsed 'code'
        $reason = Get-Prop $parsed 'reason'
        $message = Get-Prop $parsed 'message'

        if (-not [string]::IsNullOrWhiteSpace($code)) {
            Write-ScriptMessage "Detail : $code / $reason" 'Red'
        }
        if (-not [string]::IsNullOrWhiteSpace($message)) {
            Write-Host "  $message" -ForegroundColor 'Red'
        }
    }
    catch {
        Write-Host $Body -ForegroundColor 'Red'
    }
}

$outputPath = Resolve-OutputFile
Write-ScriptMessage "Fichier de sortie : '$outputPath'"
Write-ScriptMessage "Appel GET sur '$Url'"

$httpClient = [System.Net.Http.HttpClient]::new()
$httpClient.Timeout = [TimeSpan]::FromSeconds(60)
$exitCode = 0
$stop = $false

try {
    do {
        try {
            $renewedThisCycle = $false
            $token = Get-AccessToken -ForceRenew:$Login
            $Login = $false

            while ($true) {
                $result = Invoke-CostRequest -Client $httpClient -Token $token

                if ($result.StatusCode -eq 401 -and -not $renewedThisCycle) {
                    Write-ScriptMessage 'HTTP 401 (Unauthorized) - jeton invalide ou expire.' $AuthColor
                    Show-UnauthorizedDetail -Body $result.Body
                    $renewedThisCycle = $true
                    $token = Get-AccessToken -ForceRenew
                    Write-ScriptMessage 'Nouvelle tentative avec le jeton renouvele...' $AuthColor
                    continue
                }

                break
            }

            if ($result.StatusCode -ne 200) {
                Write-ScriptMessage "HTTP $($result.StatusCode) ($($result.ReasonPhrase)) - arret du script." 'Red'
                if ($result.StatusCode -eq 401) {
                    Show-UnauthorizedDetail -Body $result.Body
                }
                elseif (-not [string]::IsNullOrWhiteSpace($result.Body)) {
                    Write-Host $result.Body -ForegroundColor 'Red'
                }

                $exitCode = 1
                $stop = $true
            }
            else {
                if ([string]::IsNullOrWhiteSpace($result.Body)) {
                    throw 'La reponse HTTP 200 est vide.'
                }

                $parsedJson = $result.Body | ConvertFrom-Json
                $jsonLine = $parsedJson | ConvertTo-Json -Compress -Depth 100

                Add-ResponseToFile -Path $outputPath -Json $jsonLine
                Write-Host $jsonLine -ForegroundColor $ResponseColor
                Write-ScriptMessage "HTTP 200 - JSON ajoute dans '$outputPath'"
            }
        }
        catch {
            Write-ScriptMessage "Echec de l'appel : $($_.Exception.Message)" 'Red'
        }

        if ($stop) { break }

        if (-not $Once) {
            Start-Sleep -Seconds $IntervalSeconds
        }
    } while (-not $Once)
}
finally {
    $httpClient.Dispose()
}

exit $exitCode
