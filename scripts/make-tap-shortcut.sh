#!/bin/bash
# Builds and signs the "Daybook Tap" Shortcut on a Mac, ready to import.
#   bash scripts/make-tap-shortcut.sh
# It asks for your Daybook address and Shortcut secret (both on Today → Spending → Set up the Shortcut).
# The secret goes only into the Shortcut file on this Mac; nothing is uploaded.
# Then: open the signed file to add it to Shortcuts (it syncs to your iPhone), and on the iPhone make the
# trigger: Automation → + → Wallet → your payment cards → Run Immediately → pick "Daybook Tap".
set -euo pipefail

command -v shortcuts >/dev/null || { echo "This needs macOS 12 or later (the 'shortcuts' command)."; exit 1; }

read -r -p "Daybook address (ends in /app/shortcuts/signal): " URL
read -r -s -p "Shortcut secret (hidden as you type): " SECRET; echo
[[ "$URL" == https://*"/app/shortcuts/signal" ]] || { echo "That address should start with https:// and end with /app/shortcuts/signal"; exit 1; }
[[ ${#SECRET} -ge 32 ]] || { echo "That secret looks too short (it's at least 32 characters)."; exit 1; }

# Words that mark a bar in a merchant's name. Matching happens on the iPhone; only "bar" or "other" is sent.
BAR_WORDS='(?i)\b(bar|pub|tavern|taproom|brewing|brewery|saloon|lounge|cantina|beer|wine|cocktail|spirits)'

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }
uuid() { uuidgen; }
OUT_DIR=${OUT_DIR:-$PWD}
RAW="$OUT_DIR/Daybook Tap (unsigned).shortcut"
SIGNED="$OUT_DIR/Daybook Tap.shortcut"
IF_GROUP=$(uuid); MATCH_UUID=$(uuid); ENDIF_UUID=$(uuid)

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

<!-- Does the merchant's name look like a bar? (on the phone only) -->
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.text.match</string>
<key>WFWorkflowActionParameters</key><dict>
<key>UUID</key><string>$MATCH_UUID</string>
<key>WFMatchTextPattern</key><string>$(xml "$BAR_WORDS")</string>
<key>WFMatchTextCaseSensitive</key><false/>
<key>text</key>$(input_property Merchant)
</dict></dict>

<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.conditional</string>
<key>WFWorkflowActionParameters</key><dict>
<key>GroupingIdentifier</key><string>$IF_GROUP</string><key>WFControlFlowMode</key><integer>0</integer>
<key>WFCondition</key><integer>100</integer>
<key>WFInput</key><dict><key>Type</key><string>Variable</string><key>Variable</key><dict><key>Value</key><dict>
<key>OutputName</key><string>Matches</string><key>OutputUUID</key><string>$MATCH_UUID</string><key>Type</key><string>ActionOutput</string></dict>
<key>WFSerializationType</key><string>WFTextTokenAttachment</string></dict></dict>
</dict></dict>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.gettext</string>
<key>WFWorkflowActionParameters</key><dict><key>UUID</key><string>$(uuid)</string><key>WFTextActionText</key>$(plain_text bar)</dict></dict>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.conditional</string>
<key>WFWorkflowActionParameters</key><dict><key>GroupingIdentifier</key><string>$IF_GROUP</string><key>WFControlFlowMode</key><integer>1</integer></dict></dict>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.gettext</string>
<key>WFWorkflowActionParameters</key><dict><key>UUID</key><string>$(uuid)</string><key>WFTextActionText</key>$(plain_text other)</dict></dict>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.conditional</string>
<key>WFWorkflowActionParameters</key><dict><key>GroupingIdentifier</key><string>$IF_GROUP</string><key>WFControlFlowMode</key><integer>2</integer><key>UUID</key><string>$ENDIF_UUID</string></dict></dict>

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
$(field category "<dict><key>Value</key><dict><key>attachmentsByRange</key><dict><key>{0, 1}</key><dict><key>OutputName</key><string>If Result</string><key>OutputUUID</key><string>$ENDIF_UUID</string><key>Type</key><string>ActionOutput</string></dict></dict><key>string</key><string>&#xFFFC;</string></dict><key>WFSerializationType</key><string>WFTextTokenString</string></dict>")
</array></dict><key>WFSerializationType</key><string>WFDictionaryFieldValue</string></dict>
</dict></dict>

</array></dict></plist>
EOF

plutil -lint "$RAW" >/dev/null || { echo "Built an invalid file; please report this."; exit 1; }
shortcuts sign --mode anyone --input "$RAW" --output "$SIGNED"
rm -f "$RAW"
echo
echo "Done: $SIGNED"
echo "1. Open it (double-click) and tap Add Shortcut. It syncs to your iPhone through iCloud."
echo "2. On the iPhone: Shortcuts → Automation → + → Wallet → your payment cards → Run Immediately → Next"
echo "   → pick \"Daybook Tap\" under My Shortcuts."
echo "3. Delete any older Wallet automation, so a tap isn't counted twice."
echo "4. Tap Apple Pay in a store, then check Today → Spending → Shortcut status."
