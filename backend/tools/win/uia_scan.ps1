# uia_scan.ps1 — Windows UI Automation element scanner.
#
# Ported from Screen-AI (screen_element_scanner/uia_scan.ps1) so the Voice Agent
# gets REAL structured UI elements (role/label/automation_id/bounds/center)
# instead of the previous stub. Emits a single JSON array on stdout.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File uia_scan.ps1 -MaxDepth 8 -MaxElements 2500

param(
  [int]$MaxDepth = 8,
  [int]$MaxElements = 2500
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null

$script:items = New-Object System.Collections.Generic.List[object]
$script:seen = New-Object 'System.Collections.Generic.HashSet[string]'
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$root = [System.Windows.Automation.AutomationElement]::RootElement

$interestingTypes = @(
  "ControlType.Button",
  "ControlType.Edit",
  "ControlType.Hyperlink",
  "ControlType.CheckBox",
  "ControlType.RadioButton",
  "ControlType.ComboBox",
  "ControlType.ListItem",
  "ControlType.MenuItem",
  "ControlType.TabItem",
  "ControlType.DataItem",
  "ControlType.HeaderItem",
  "ControlType.SplitButton",
  "ControlType.Spinner",
  "ControlType.Slider",
  "ControlType.Document",
  "ControlType.Pane",
  "ControlType.Window"
)

function Get-ElementKey($element) {
  try {
    $r = $element.Current.BoundingRectangle
  } catch {
    return
  }
  return "$($element.Current.ControlType.ProgrammaticName)|$($element.Current.Name)|$($element.Current.AutomationId)|$([int]$r.Left),$([int]$r.Top),$([int]$r.Right),$([int]$r.Bottom)"
}

function Add-Element($element, [int]$depth) {
  if ($null -eq $element) { return }
  if ($script:items.Count -ge $MaxElements) { return }

  try {
    $r = $element.Current.BoundingRectangle
    $typeName = $element.Current.ControlType.ProgrammaticName
    $name = $element.Current.Name
    $automationId = $element.Current.AutomationId
    $localizedControlType = $element.Current.LocalizedControlType
    $className = $element.Current.ClassName
    $processId = $element.Current.ProcessId
    
    $isEnabled = $element.Current.IsEnabled
    $isKeyboardFocusable = $element.Current.IsKeyboardFocusable
    $hasKeyboardFocus = $element.Current.HasKeyboardFocus
  } catch {
    return
  }

  $patterns = @()
  $isSelected = $null
  $isExpanded = $null
  $toggleState = $null
  $value = $null

  try {
    $null = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $patterns += 'invoke'
  } catch {}

  try {
    $togglePattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $patterns += 'toggle'
    $toggleState = $togglePattern.Current.ToggleState.ToString()
  } catch {}

  try {
    $selPattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $patterns += 'selection_item'
    $isSelected = $selPattern.Current.IsSelected
  } catch {}

  try {
    $valPattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $patterns += 'value'
    $value = $valPattern.Current.Value
  } catch {}

  try {
    $null = $element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    $patterns += 'scroll'
  } catch {}

  try {
    $expPattern = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    $patterns += 'expand_collapse'
    $isExpanded = ($expPattern.Current.ExpandCollapseState.ToString() -eq "Expanded")
  } catch {}
  $w = [double]($r.Right - $r.Left)
  $h = [double]($r.Bottom - $r.Top)
  if ($w -le 1 -or $h -le 1) { return }
  if ([string]::IsNullOrWhiteSpace($typeName)) { return }

  $hasUsefulText = -not [string]::IsNullOrWhiteSpace($name) -or -not [string]::IsNullOrWhiteSpace($automationId)
  $isInteresting = $interestingTypes -contains $typeName
  if (-not $isInteresting -and -not $hasUsefulText) { return }

  $key = Get-ElementKey $element
  if ([string]::IsNullOrWhiteSpace($key)) { return }
  if (-not $script:seen.Add($key)) { return }

  $out = [ordered]@{
    source = "uia"
    role = $typeName.Replace("ControlType.", "").ToLowerInvariant()
    localized_role = $localizedControlType
    label = $name
    automation_id = $automationId
    class_name = $className
    process_id = $processId
    depth = $depth
    bounds = @(
      [int]$r.Left,
      [int]$r.Top,
      [int]$r.Right,
      [int]$r.Bottom
    )
    center = @(
      [int](($r.Left + $r.Right) / 2),
      [int](($r.Top + $r.Bottom) / 2)
    )
    confidence = 0.95
    is_enabled = $isEnabled
    is_keyboard_focusable = $isKeyboardFocusable
    has_keyboard_focus = $hasKeyboardFocus
    patterns = $patterns
  }

  if ($null -ne $isSelected) { $out['is_selected'] = $isSelected }
  if ($null -ne $isExpanded) { $out['is_expanded'] = $isExpanded }
  if ($null -ne $toggleState) { $out['toggle_state'] = $toggleState }
  if ($null -ne $value) { $out['value'] = $value }

  $script:items.Add($out) | Out-Null
}

function Walk-Element($element, [int]$depth) {
  if ($null -eq $element) { return }
  if ($depth -gt $MaxDepth) { return }
  if ($script:items.Count -ge $MaxElements) { return }

  Add-Element $element $depth

  try {
    $child = $walker.GetFirstChild($element)
  } catch {
    return
  }
  while ($null -ne $child) {
    Walk-Element $child ($depth + 1)
    if ($script:items.Count -ge $MaxElements) { return }
    try {
      $child = $walker.GetNextSibling($child)
    } catch {
      return
    }
  }
}

Walk-Element $root 0

$script:items | ConvertTo-Json -Depth 6
