#!/bin/bash
# Builds and signs the "Daybook Tap" Shortcut on a Mac, ready to import.
#   bash scripts/make-tap-shortcut.sh
#   DAYBOOK_URL=… DAYBOOK_SECRET=… bash scripts/make-tap-shortcut.sh     (no questions asked)
# The address and secret are in Daybook → Settings → Shortcuts ("Tap to pay", and Show/Copy for the secret).
# The secret goes only into the Shortcut file on this Mac; nothing is uploaded.
# Then: open the signed file to add it to Shortcuts (it syncs to your iPhone), and on the iPhone make the
# trigger: Automation → + → Wallet → your payment cards → Run Immediately → pick "Daybook Tap".
set -euo pipefail

command -v shortcuts >/dev/null || { echo "This needs macOS 12 or later (the 'shortcuts' command)."; exit 1; }

URL=${DAYBOOK_URL:-}
SECRET=${DAYBOOK_SECRET:-}
[[ -n "$URL" ]] || read -r -p "Tap to pay address from Settings → Shortcuts (ends in /app/shortcuts/signal): " URL
[[ -n "$SECRET" ]] || { read -r -s -p "Shortcut secret from Settings → Shortcuts (hidden as you type): " SECRET; echo; }
[[ "$URL" == https://*"/app/shortcuts/signal" ]] || { echo "That address should start with https:// and end with /app/shortcuts/signal"; exit 1; }
[[ ${#SECRET} -ge 32 ]] || { echo "That secret looks too short (it's at least 32 characters)."; exit 1; }

# Kinds of place, checked in this order against the merchant's name ON THE IPHONE; only the label is sent.
# First match wins, so "TeKu Tavern + Cafe" is a bar. Edit or add lines to suit your usual spots
# (label|regular expression); add a label to Daybook's "Kinds of place" if it should log drinks or food.
RULES=(
  'bar|(?i)\b(bar|pub|tavern|tap ?room|brewing|brewery|brewhouse|saloon|lounge|cantina|beer|wine|cocktails?|spirits|distillery|cidery)\b'
  'coffee|(?i)\b(espresso|coffee|cafe|café|caffe|roasters?|roastery|starbucks|peet|dutch bros|tea)\b'
  'food|(?i)\b(taqueria|tacos?|restaurant|kitchen|grill|pizza|pizzeria|burgers?|ramen|pho|sushi|deli|bakery|bagels?|diner|bbq|thai|noodles?|bistro|eatery|chipotle|mcdonald|subway|teriyaki|dumplings?)\b'
  'gas|(?i)\b(shell|chevron|arco|76|exxon|mobil|bp|texaco|valero|fuel|gas station)\b'
  'grocery|(?i)\b(qfc|safeway|trader joe|whole foods|fred meyer|grocery|groceries|uwajimaya|pcc|albertsons|kroger|h mart|metropolitan market|town & country)\b'
  'parking|(?i)\b(parking|paybyphone|impark|diamond parking|spothero|park ?mobile)\b'
)

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }
uuid() { uuidgen; }
OUT_DIR=${OUT_DIR:-$PWD}
RAW="$OUT_DIR/Daybook Tap (unsigned).shortcut"
SIGNED="$OUT_DIR/Daybook Tap.shortcut"
# The unsigned file holds the secret in plain text: it is removed however the script ends (trap below).

# A text field holding one Shortcut Input property (Amount, Merchant, Card or Pass).
input_property() { cat <<EOF
<dict><key>Value</key><dict><key>attachmentsByRange</key><dict><key>{0, 1}</key><dict>
<key>Aggrandizements</key><array><dict><key>PropertyName</key><string>$1</string><key>Type</key><string>WFPropertyVariableAggrandizement</string></dict></array>
<key>Type</key><string>ExtensionInput</string></dict></dict><key>string</key><string>&#xFFFC;</string></dict>
<key>WFSerializationType</key><string>WFTextTokenString</string></dict>
EOF
}
plain_text() { printf '<dict><key>Value</key><dict><key>string</key><string>%s</string></dict><key>WFSerializationType</key><string>WFTextTokenString</string></dict>' "$(xml "$1")"; }
field() { printf '<dict><key>WFItemType</key><integer>0</integer><key>WFKey</key>%s<key>WFValue</key>%s</dict>' "$(plain_text "$1")" "$2"; }

# Nested "Match Text → If it matched → label, Otherwise → next rule", ending in "other". The outermost
# End If's result is the label of the first rule that matched.
OUTER_END=""
kind_actions() {
  local groups=() ends=() rule label pattern match group
  for rule in "${RULES[@]}"; do
    label=${rule%%|*}; pattern=${rule#*|}
    match=$(uuid); group=$(uuid); groups+=("$group"); ends+=("$(uuid)")
    cat <<A
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.text.match</string>
<key>WFWorkflowActionParameters</key><dict><key>UUID</key><string>$match</string>
<key>WFMatchTextPattern</key><string>$(xml "$pattern")</string><key>WFMatchTextCaseSensitive</key><false/>
<key>text</key>$(input_property Merchant)</dict></dict>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.conditional</string>
<key>WFWorkflowActionParameters</key><dict><key>GroupingIdentifier</key><string>$group</string><key>WFControlFlowMode</key><integer>0</integer>
<key>WFCondition</key><integer>100</integer>
<key>WFInput</key><dict><key>Type</key><string>Variable</string><key>Variable</key><dict><key>Value</key><dict>
<key>OutputName</key><string>Matches</string><key>OutputUUID</key><string>$match</string><key>Type</key><string>ActionOutput</string></dict>
<key>WFSerializationType</key><string>WFTextTokenAttachment</string></dict></dict></dict></dict>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.gettext</string>
<key>WFWorkflowActionParameters</key><dict><key>UUID</key><string>$(uuid)</string><key>WFTextActionText</key>$(plain_text "$label")</dict></dict>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.conditional</string>
<key>WFWorkflowActionParameters</key><dict><key>GroupingIdentifier</key><string>$group</string><key>WFControlFlowMode</key><integer>1</integer></dict></dict>
A
  done
  cat <<A
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.gettext</string>
<key>WFWorkflowActionParameters</key><dict><key>UUID</key><string>$(uuid)</string><key>WFTextActionText</key>$(plain_text other)</dict></dict>
A
  local i
  for (( i=${#groups[@]}-1; i>=0; i-- )); do
    cat <<A
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.conditional</string>
<key>WFWorkflowActionParameters</key><dict><key>GroupingIdentifier</key><string>${groups[$i]}</string><key>WFControlFlowMode</key><integer>2</integer><key>UUID</key><string>${ends[$i]}</string></dict></dict>
A
  done
  printf '%s' "${ends[0]}" > "$OUTER_FILE"
}
OUTER_FILE=$(mktemp)
trap 'rm -f "$RAW" "$OUTER_FILE"' EXIT
KIND_XML=$(kind_actions)
OUTER_END=$(cat "$OUTER_FILE")

cat > "$RAW" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>WFWorkflowClientVersion</key><string>2607.0.2</string>
<key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
<key>WFWorkflowMinimumClientVersionString</key><string>900</string>
<key>WFWorkflowIcon</key><dict><key>WFWorkflowIconGlyphNumber</key><integer>59446</integer><key>WFWorkflowIconStartColor</key><integer>2071128575</integer></dict>
<key>WFWorkflowImportQuestions</key><array/>
<key>WFWorkflowTypes</key><array/>
<key>WFWorkflowHasShortcutInputVariables</key><true/>
<key>WFWorkflowInputContentItemClasses</key><array>
<string>WFAppContentItem</string><string>WFAppStoreAppContentItem</string><string>WFArticleContentItem</string><string>WFContactContentItem</string><string>WFDateContentItem</string><string>WFEmailAddressContentItem</string><string>WFFolderContentItem</string><string>WFGenericFileContentItem</string><string>WFImageContentItem</string><string>WFiTunesProductContentItem</string><string>WFLocationContentItem</string><string>WFDCMapsLinkContentItem</string><string>WFAVAssetContentItem</string><string>WFPDFContentItem</string><string>WFPhoneNumberContentItem</string><string>WFRichTextContentItem</string><string>WFSafariWebPageContentItem</string><string>WFStringContentItem</string><string>WFURLContentItem</string><string>WFNumberContentItem</string><string>WFDictionaryContentItem</string>
</array>
<key>WFWorkflowActions</key><array>

<!-- Which kind of place is this? Nested Match → If, one per rule; the merchant's name stays on the phone. -->
$KIND_XML

<!-- Send the tap to Daybook -->
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.downloadurl</string>
<key>WFWorkflowActionParameters</key><dict>
<key>UUID</key><string>$(uuid)</string>
<key>WFURL</key><string>$(xml "$URL")</string>
<key>WFHTTPMethod</key><string>POST</string>
<key>ShowHeaders</key><true/>
<key>WFHTTPHeaders</key><dict><key>Value</key><dict><key>WFDictionaryFieldValueItems</key><array>
$(field Authorization "$(plain_text "Bearer $SECRET")")
</array></dict><key>WFSerializationType</key><string>WFDictionaryFieldValue</string></dict>
<key>WFHTTPBodyType</key><string>JSON</string>
<key>WFJSONValues</key><dict><key>Value</key><dict><key>WFDictionaryFieldValueItems</key><array>
$(field kind "$(plain_text payment)")
$(field amount "$(input_property Amount)")
$(field card "$(input_property "Card or Pass")")
$(field category "<dict><key>Value</key><dict><key>attachmentsByRange</key><dict><key>{0, 1}</key><dict><key>OutputName</key><string>If Result</string><key>OutputUUID</key><string>$OUTER_END</string><key>Type</key><string>ActionOutput</string></dict></dict><key>string</key><string>&#xFFFC;</string></dict><key>WFSerializationType</key><string>WFTextTokenString</string></dict>")
</array></dict><key>WFSerializationType</key><string>WFDictionaryFieldValue</string></dict>
</dict></dict>

</array></dict></plist>
EOF

plutil -lint "$RAW" >/dev/null || { echo "Built an invalid file; please report this."; exit 1; }
if ! shortcuts sign --mode anyone --input "$RAW" --output "$SIGNED" 2>/tmp/daybook-sign.err || [[ ! -s "$SIGNED" ]]; then
  echo "Signing failed: $(tr '\n' ' ' </tmp/daybook-sign.err)"
  echo "Signing needs you signed in to iCloud on this Mac, a network connection, and Shortcuts opened once."
  echo "Check those and run this again. Nothing was installed."
  rm -f /tmp/daybook-sign.err; exit 1
fi
rm -f /tmp/daybook-sign.err
echo
echo "Done: $SIGNED"
echo "1. Open it (double-click) and tap Add Shortcut. It syncs to your iPhone through iCloud."
echo "2. On the iPhone: Shortcuts → Automation → + → Wallet → your payment cards → Run Immediately → Next"
echo "   → pick \"Daybook Tap\" under My Shortcuts."
echo "3. Delete any older Wallet automation, so a tap isn't counted twice."
echo "4. Tap Apple Pay in a store, then check Today → Spending → Shortcut status."
