// One person's hosted dashboard on Azure App Service (references/hosting.md). The People
// page deploys it per person from your local dashboard (az deployment group create, with a
// what-if preview first); you can also deploy it by hand:
//
//   az deployment group create -g dashboard-rg --template-file app-service-person.bicep \
//     --parameters appName=dash-ana person=ana email=ana@example.com plan=dashboard-asp ...
//
// Copy it into the workspace (e.g. hosting/app-service-person.bicep) and change what you
// like; the People page sets the parameters marked "People page" and passes everything in
// hosting.json's platform.parameters and the person's profile parameters.
//
// Before the first deployment, once (see hosting.md "Azure App Service"):
//   - an App Service plan (Linux), a storage account for the file shares, a container
//     registry with the dashboard image, and a Key Vault using Azure RBAC;
//   - in the Key Vault: the router's backend secret (secret "dashboard-backend-secret"),
//     the snapshot SAS if you use one ("snapshot-azure-sas"), and each area's key;
//   - whoever deploys needs to create role assignments on the vault and registry (Owner,
//     or Role Based Access Control Administrator), and list keys on the storage account.

// ---- set by the People page
@description('The Web App name; also its file share.')
param appName string
@description('The person\'s short name (natterjack-person tag).')
param person string
@description('Their email: the only person this dashboard serves.')
param email string
@description('Their profile id (natterjack-profile tag).')
param profile string = ''
@description('Hash of what was applied (natterjack-applied tag), so the People page can tell who needs an update.')
param applied string = ''
@description('1-10 caps their runs at once; 0 leaves deck.json\'s limit.')
param maxConcurrentRuns int = 0
@description('Their areas: [{ name: "KNOWLEDGE_FINANCE_KEY", secretName: "natterjack-area-finance" }], each a Key Vault secret.')
param areaSettings array = []

// ---- set in hosting.json platform.parameters (or a profile's parameters)
@description('The App Service plan (Linux) in this resource group. A profile can pick a bigger one.')
param plan string
@description('Storage account (this resource group) holding everyone\'s file shares, mounted at /data.')
param storageAccount string
@description('Container registry (this resource group) the image comes from, e.g. confirmdashacr.')
param registry string
@description('The dashboard image in that registry, e.g. natterjack-dashboard:1.')
param image string
@description('Key Vault (this resource group, Azure RBAC) holding the secrets.')
param keyVault string
@description('The one address everyone opens (the router\'s), e.g. https://natterjack.example.com.')
param publicUrl string
@description('Where the router puts the signed-in email.')
param identityHeader string = 'X-Forwarded-Email'
@description('repos.json\'s snapshot block as JSON, to install the workspace from a published snapshot; empty to use WORKSPACE_REPO.')
param snapshotConfig string = ''
@description('The workspace repo, when not using a snapshot.')
param workspaceRepo string = ''
param location string = resourceGroup().location

var kvRef = 'https://${keyVault}${environment().suffixes.keyvaultDns}/secrets'
var baseSettings = [
  { name: 'WEBSITES_PORT', value: '3333' }
  { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
  { name: 'WEBSITES_CONTAINER_START_TIME_LIMIT', value: '1800' }
  { name: 'DASHBOARD_HOSTED', value: '1' }
  { name: 'DASHBOARD_PUBLIC_URL', value: publicUrl }
  { name: 'DASHBOARD_OWNER', value: email }
  { name: 'DASHBOARD_IDENTITY_HEADER', value: identityHeader }
  // The router sends this app's own address as the Host (App Service routes by it).
  { name: 'DASHBOARD_ALLOWED_HOSTS', value: '${appName}.azurewebsites.net' }
  { name: 'DASHBOARD_PROXY_SECRET', value: '@Microsoft.KeyVault(SecretUri=${kvRef}/dashboard-backend-secret)' }
]
var runSettings = maxConcurrentRuns > 0 ? [{ name: 'DASHBOARD_MAX_CONCURRENT_RUNS', value: string(maxConcurrentRuns) }] : []
var workspaceSettings = !empty(snapshotConfig)
  ? [
      { name: 'SNAPSHOT_CONFIG', value: snapshotConfig }
      { name: 'SNAPSHOT_AZURE_SAS', value: '@Microsoft.KeyVault(SecretUri=${kvRef}/snapshot-azure-sas)' }
    ]
  : (!empty(workspaceRepo) ? [{ name: 'WORKSPACE_REPO', value: workspaceRepo }] : [])
var areaAppSettings = [for a in areaSettings: { name: a.name, value: '@Microsoft.KeyVault(SecretUri=${kvRef}/${a.secretName})' }]

resource servicePlan 'Microsoft.Web/serverfarms@2023-12-01' existing = { name: plan }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageAccount }
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registry }
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: keyVault }

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  name: '${storageAccount}/default/${appName}'
  properties: { shareQuota: 10 }
}

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  kind: 'app,linux,container'
  identity: { type: 'SystemAssigned' }
  tags: {
    'natterjack-owner': email
    'natterjack-person': person
    'natterjack-profile': profile
    'natterjack-applied': applied
    'natterjack-share': appName
    // Where the share is (a profile can pick another account), so removing deletes the right one.
    'natterjack-storage': storageAccount
  }
  properties: {
    serverFarmId: servicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${acr.properties.loginServer}/${image}'
      acrUseManagedIdentityCreds: true
      alwaysOn: true // idle apps are otherwise unloaded mid-run
      http20Enabled: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: concat(baseSettings, runSettings, workspaceSettings, areaAppSettings)
      azureStorageAccounts: {
        data: {
          type: 'AzureFiles'
          accountName: storageAccount
          shareName: appName
          mountPath: '/data'
          accessKey: storage.listKeys().keys[0].value
        }
      }
    }
  }
  dependsOn: [share]
}

// The app's own identity reads its secrets and pulls its image; nothing else.
resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, app.id, 'Key Vault Secrets User')
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, app.id, 'AcrPull')
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output host string = app.properties.defaultHostName
