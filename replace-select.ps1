# Save App.tsx as UTF-8 without BOM first
 = Get-Content src\App.tsx -Raw
[System.IO.File]::WriteAllText('src/App.tsx', , [System.Text.UTF8Encoding]::new(False))

# Read as UTF-8
 = Get-Content src\App.tsx

# Step 1: Remove Select from import line
 =  -replace ',\s*Select,', ','
 =  -replace ',\s*Select\s*$', '}'

# Step 2: Add CustomSelect import after FluentUI import block
 =  | Select-String "@fluentui/react-components" | Select-Object -First 1
if () {
     = .IndexOf(.Line)
     = [0..] + "import CustomSelect from './components/CustomSelect'" + [(+1)...Length]
}

Write-Host "Script prepared. Now run the node.js replacement."
