# 测试部署后的网站状态
$baseUrl = "https://file-rocket.13957326829.workers.dev"

# 测试根路径
Write-Host "测试根路径: $baseUrl"
try {
    $response = Invoke-WebRequest -Uri $baseUrl -Method Head -UseBasicParsing
    Write-Host "状态码: $($response.StatusCode)"
    Write-Host "内容类型: $($response.Headers['Content-Type'])"
    Write-Host "成功!"
} catch {
    Write-Host "错误: $($_.Exception.Message)"
}
Write-Host ""

# 测试upload路径
Write-Host "测试upload路径: $baseUrl/upload"
try {
    $response = Invoke-WebRequest -Uri "$baseUrl/upload" -Method Head -UseBasicParsing
    Write-Host "状态码: $($response.StatusCode)"
    Write-Host "内容类型: $($response.Headers['Content-Type'])"
    Write-Host "成功!"
} catch {
    Write-Host "错误: $($_.Exception.Message)"
}
Write-Host ""

# 测试receive路径
Write-Host "测试receive路径: $baseUrl/receive"
try {
    $response = Invoke-WebRequest -Uri "$baseUrl/receive" -Method Head -UseBasicParsing
    Write-Host "状态码: $($response.StatusCode)"
    Write-Host "内容类型: $($response.Headers['Content-Type'])"
    Write-Host "成功!"
} catch {
    Write-Host "错误: $($_.Exception.Message)"
}
Write-Host ""

# 测试JavaScript文件
Write-Host "测试upload.js: $baseUrl/upload.js"
try {
    $response = Invoke-WebRequest -Uri "$baseUrl/upload.js" -Method Head -UseBasicParsing
    Write-Host "状态码: $($response.StatusCode)"
    Write-Host "内容类型: $($response.Headers['Content-Type'])"
    Write-Host "成功!"
} catch {
    Write-Host "错误: $($_.Exception.Message)"
}
Write-Host ""

Write-Host "测试receive.js: $baseUrl/receive.js"
try {
    $response = Invoke-WebRequest -Uri "$baseUrl/receive.js" -Method Head -UseBasicParsing
    Write-Host "状态码: $($response.StatusCode)"
    Write-Host "内容类型: $($response.Headers['Content-Type'])"
    Write-Host "成功!"
} catch {
    Write-Host "错误: $($_.Exception.Message)"
}
Write-Host ""

Write-Host "所有测试完成!"