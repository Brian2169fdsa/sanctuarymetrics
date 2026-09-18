<#
    register-app.ps1
    Creates the read-only usage-reporting app in one or more tenants and
    writes config.json for scan.py.

    You sign in interactively per tenant as Global Admin. Nothing is stored
    except the client secrets it generates.

    Requires: Install-Module Microsoft.Graph -Scope CurrentUser

    Usage:
      .\register-app.ps1 -Tenants @{
          "Cholla Behavioral Health" = "cholla.onmicrosoft.com"
          "Sanctuary Recovery"       = "sanctuary.onmicrosoft.com"
      }

      .\register-app.ps1 -Tenants @{...} -Enrich    # adds Sites/Group read
#>

param(
    [Parameter(Mandatory = $true)] [hashtable] $Tenants,
    [string] $AppName = "Usage Reporting (read-only)",
    [switch] $Enrich,
    [int]    $SecretMonths = 12,
    [string] $OutFile = "config.json"
)

$ErrorActionPreference = "Stop"
$GraphAppId = "00000003-0000-0000-c000-000000000000"

# Reports.Read.All alone cannot read a file, message, or mailbox.
$Roles = @("Reports.Read.All")
if ($Enrich) { $Roles += @("Sites.Read.All", "Group.Read.All") }

$config = @{ tenants = @() }

foreach ($name in $Tenants.Keys) {
    $domain = $Tenants[$name]
    Write-Host "`n=== $name ($domain) ===" -ForegroundColor Cyan

    Connect-MgGraph -TenantId $domain -NoWelcome `
        -Scopes "Application.ReadWrite.All", "AppRoleAssignment.ReadWrite.All"
    $ctx = Get-MgContext
    Write-Host "signed in as $($ctx.Account)"

    # --- app registration ---------------------------------------------------
    $existing = Get-MgApplication -Filter "displayName eq '$AppName'" -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "app already exists, reusing $($existing.AppId)" -ForegroundColor Yellow
        $app = $existing | Select-Object -First 1
    } else {
        $app = New-MgApplication -DisplayName $AppName -SignInAudience "AzureADMyOrg"
        Write-Host "created app $($app.AppId)"
        Start-Sleep -Seconds 8   # replication
    }

    $sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'" -ErrorAction SilentlyContinue
    if (-not $sp) {
        $sp = New-MgServicePrincipal -AppId $app.AppId
        Start-Sleep -Seconds 5
    }

    # --- grant application permissions --------------------------------------
    $graphSp = Get-MgServicePrincipal -Filter "appId eq '$GraphAppId'"
    $granted = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id `
        -ErrorAction SilentlyContinue

    foreach ($roleValue in $Roles) {
        $role = $graphSp.AppRoles | Where-Object {
            $_.Value -eq $roleValue -and $_.AllowedMemberTypes -contains "Application"
        }
        if (-not $role) { Write-Warning "role $roleValue not found"; continue }

        if ($granted | Where-Object { $_.AppRoleId -eq $role.Id }) {
            Write-Host "  already granted: $roleValue"
            continue
        }
        New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id `
            -PrincipalId $sp.Id -ResourceId $graphSp.Id -AppRoleId $role.Id | Out-Null
        Write-Host "  granted: $roleValue" -ForegroundColor Green
    }

    # --- secret -------------------------------------------------------------
    $secret = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential @{
        displayName = "scan.py"
        endDateTime = (Get-Date).AddMonths($SecretMonths)
    }
    Write-Host "  secret expires $($secret.EndDateTime.ToString('yyyy-MM-dd'))" -ForegroundColor Yellow

    $config.tenants += [ordered]@{
        name          = $name
        tenant_id     = $ctx.TenantId
        client_id     = $app.AppId
        client_secret = $secret.SecretText
    }

    Disconnect-MgGraph | Out-Null
}

$config | ConvertTo-Json -Depth 4 | Set-Content -Path $OutFile -Encoding UTF8
Write-Host "`nWrote $OutFile with $($config.tenants.Count) tenant(s)." -ForegroundColor Green
Write-Host "Secrets are in that file in plaintext. Keep it out of git." -ForegroundColor Yellow
Write-Host "Next: python3 tools/scan.py --config $OutFile --enrich --out out/"
