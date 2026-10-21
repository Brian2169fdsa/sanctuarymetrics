<#
    register-signin-app.ps1
    Creates the "Sign in with Microsoft" app for the metrics site in the
    Sanctuary tenant and prints the three values Vercel needs.

    The app can only read who signed in (openid, profile, email) — no mail,
    files or other data. Only people in this tenant can use it.

    You sign in interactively as a Global Admin (or Application Admin).
    Nothing is stored; copy the printed values into Vercel.

    Requires: Install-Module Microsoft.Graph -Scope CurrentUser

    Usage:
      .\register-signin-app.ps1 -Tenant sanctuaryrecoverycenters.com
      .\register-signin-app.ps1 -Tenant sanctuaryrecoverycenters.com -SiteUrl https://metrics.example.org
#>

param(
    [Parameter(Mandatory = $true)] [string] $Tenant,
    [string] $SiteUrl = "https://sanctuarymetrics.vercel.app",
    [string] $AppName = "Sanctuary Metrics sign-in",
    [int]    $SecretMonths = 24
)

$ErrorActionPreference = "Stop"
$GraphAppId = "00000003-0000-0000-c000-000000000000"
# delegated sign-in scopes on Microsoft Graph
$Scopes = @{
    openid  = "37f7f235-527c-4136-accd-4a02d197296e"
    profile = "14dad69e-099b-42c9-810b-d002981feec1"
    email   = "64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0"
}
$Redirect = $SiteUrl.TrimEnd("/") + "/api/microsoft"

Connect-MgGraph -TenantId $Tenant -NoWelcome `
    -Scopes "Application.ReadWrite.All", "DelegatedPermissionGrant.ReadWrite.All"
$ctx = Get-MgContext
Write-Host "signed in as $($ctx.Account) to tenant $($ctx.TenantId)" -ForegroundColor Cyan

# --- app registration --------------------------------------------------------
$access = @{
    ResourceAppId  = $GraphAppId
    ResourceAccess = @($Scopes.Values | ForEach-Object { @{ Id = $_; Type = "Scope" } })
}
$existing = Get-MgApplication -Filter "displayName eq '$AppName'" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
    Write-Host "app already exists, updating $($existing.AppId)" -ForegroundColor Yellow
    $uris = @($existing.Web.RedirectUris) + $Redirect | Select-Object -Unique
    Update-MgApplication -ApplicationId $existing.Id -Web @{ RedirectUris = $uris } -RequiredResourceAccess @($access)
    $app = Get-MgApplication -ApplicationId $existing.Id
} else {
    $app = New-MgApplication -DisplayName $AppName -SignInAudience "AzureADMyOrg" `
        -Web @{ RedirectUris = @($Redirect) } -RequiredResourceAccess @($access) `
        -OptionalClaims @{ IdToken = @(@{ Name = "email"; Essential = $false }) }
    Write-Host "created app $($app.AppId)"
    Start-Sleep -Seconds 8   # replication
}

$sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'" -ErrorAction SilentlyContinue
if (-not $sp) {
    $sp = New-MgServicePrincipal -AppId $app.AppId
    Start-Sleep -Seconds 5
}

# --- consent once for everyone, so nobody sees a permissions prompt ----------
$graphSp = Get-MgServicePrincipal -Filter "appId eq '$GraphAppId'"
$grant = Get-MgOauth2PermissionGrant -Filter "clientId eq '$($sp.Id)' and consentType eq 'AllPrincipals'" -ErrorAction SilentlyContinue
if (-not $grant) {
    New-MgOauth2PermissionGrant -ClientId $sp.Id -ConsentType "AllPrincipals" -ResourceId $graphSp.Id `
        -Scope ($Scopes.Keys -join " ") | Out-Null
    Write-Host "granted consent for: $($Scopes.Keys -join ', ')"
}

# --- client secret -----------------------------------------------------------
$secret = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential @{
    DisplayName = "vercel " + (Get-Date -Format "yyyy-MM-dd")
    EndDateTime = (Get-Date).AddMonths($SecretMonths)
}

Write-Host "`nAdd these in Vercel -> sanctuarymetrics -> Settings -> Environment Variables (Production), then redeploy:`n" -ForegroundColor Green
Write-Host "  MS_TENANT_ID     = $($ctx.TenantId)"
Write-Host "  MS_CLIENT_ID     = $($app.AppId)"
Write-Host "  MS_CLIENT_SECRET = $($secret.SecretText)"
Write-Host "`nThe secret is shown only once and expires $($secret.EndDateTime.ToString('yyyy-MM-dd'))." -ForegroundColor Yellow
Write-Host "Redirect URI registered: $Redirect"
