# HoundStack `/clients/[clientId]` Product & UI/UX Refactor

We are performing a complete redesign and QA pass of the Client Detail experience.
This is not a visual refresh. It is a product-level redesign that should improve usability, simplify workflows, reduce user error, and establish a scalable foundation for future development.

Approach this as both a Senior Product Designer and Senior Software Engineer.

Before implementing, inspect the existing:

* database schema
* client schema
* property schema
* service/subscription schema
* visit generation logic
* billing logic
* pricing logic
* zone logic
* permissions
* audit logging

Reuse existing models whenever appropriate. Do not duplicate data or create parallel systems if suitable structures already exist.

## Primary Goals

The page should:

* be easy to scan
* be operationally focused
* be read-only by default
* separate viewing from editing
* reduce unnecessary cards and boxes
* hide creation forms until requested
* support desktop, tablet and mobile
* feel like enterprise software rather than a large settings form

## Information Architecture

Replace the existing page with:

### Persistent Header

Display:

* Client name
* Client status
* Client type
* Phone
* Email
* Property count
* Active service count
* Outstanding balance

Actions:

* Message
* Edit Client
* More Actions

### Tabs

Use:

* Summary
* Properties
* Services
* Visits
* Billing
* Activity

## Read-Only First

Nothing should be editable until the user intentionally clicks Edit.
Everything should display as read-only.
Editing should occur in drawers.
Save/Cancel should be explicit.
Warn about unsaved changes.

## Editing Drawers

Use right-side drawers.

Small:

* Edit client
* Notes
* Pause service

Medium:

* Edit property
* Edit service
* Pricing
* Hazards

Large:

* Property boundary
* Maps
* Large invoice review

On mobile these become full-screen sheets.

## Summary

Should show operational information only.

Include:

* Upcoming visit
* Recent visits
* Active services
* Property summary
* Internal notes
* Alerts
* Technician instructions
* Client communication summary

## Three Types of Notes

Create three completely separate note systems.

### Internal Office Notes

Office only.

Examples:

* billing
* reminders
* follow-up

### Technician Instructions

Visible to technicians.

Examples:

* gate code
* parking
* dog behavior
* hazards

These should appear during visit execution.

### Client Visible Notes

Visible inside portal/email/SMS.
Prevent accidental visibility changes.

## Properties

Properties should display as expandable summaries.
Do not display giant forms.

Each property should show:

* Address
* Type
* Zone
* Boundary
* Estimated time
* Active services
* Dogs
* Hazards

Actions:

* Edit
* View map
* Archive
* Delete (when allowed)

### Property Boundary

If a boundary exists:
Display it automatically.
Do NOT require clicking "View Boundary."

Show:

* embedded read-only map
* polygon overlay
* calculated area

Actions:

* Expand
* Edit
* Redraw

### Yard Size

Remove manual yard-size fields.
Yard size comes ONLY from the property boundary.

Store:

* calculated area
* derived size category

Never ask users to manually choose Small / Medium / Large.

### Estimated Time

Automatically calculate.

Use:

* property area
* dog count
* frequency
* initial cleanup
* add-ons
* hazards
* terrain
* access complexity

Allow authorized overrides.
Store override reason.

Display:

* Estimated
* Actual average
* Override indicator

### Residential vs Commercial

Residential should never display:

* HOA fields
* waste stations
* commercial fields

Commercial/HOA should display:

* waste stations
* sections
* building labels
* on-site contacts

## Dogs

Dogs belong to Properties.
Not Clients.

Dogs influence:

* pricing
* estimated service time
* technician instructions
* visits

Each dog includes:

* name
* breed
* size
* temperament
* notes
* active status

Inactive instead of delete.

## Services

Rename subscriptions in the UI as Services where appropriate.

Hide creation form until clicking: Add Service

Each service includes:

* property
* frequency
* pricing
* start date
* end date
* preferred days
* service window
* next visit
* status

Actions:

* edit
* pause
* resume
* end

Delete only if service never started.

### Scheduling

Support:

* Weekly
* Every N weeks
* Calendar Monthly
* Every X days
* One Time

Users should be able to choose:
Monthly by calendar OR Every 4 weeks.
These are different.

### Service Windows

Current UI should be redesigned.

Display:

* Earliest arrival
* Latest arrival
* Anytime

Accessible time picker.
Clear icons.
Do not confuse service window with actual arrival.

## Visits

Separate:

* Scheduled Window
* Actual Start
* Actual Completion
* Actual Duration

Technicians generate actual timing using: Start / Complete.

Missing timestamps should clearly indicate:

* Arrival not recorded
* Completion not recorded

## Billing

Billing requires a complete redesign.

Display:

* Summary
* Payment Methods
* Invoices
* Credits
* Payments
* Billing Settings

Add-ons do NOT belong in Billing.
Move them into Services.

## Pricing

Pricing precedence:

Standard Price
↓
Zone comparison
↓
Contract/Custom price
↓
Promotion
↓
Final client price

Always display:

* Standard Price
* Zone Price
* Difference
* Final Price

Never silently replace pricing.

## Zone Logic

Automatically assign zone.
Allow override.

Store:

* Auto Zone
* Effective Zone
* Override Reason
* Override User

Display:

* Detected Zone
* Override Badge

### Zone Pricing

If a matching zone exists: show comparison.

Example:

| | |
|---|---|
| Standard | $30 |
| Taylor Zone | $34 |
| Difference | +$4 |

User selects:

* Use Standard
* Use Zone
* Custom Price

### Promotions

Promotions apply against the selected service price.

Store:

* Base
* Zone
* Promotion
* Final

Never overwrite historical invoices.

## Property Removal

Archive if history exists.

Delete only when:

* No visits
* No invoices
* No payments
* No history

## Service Ending

Started services: End. Never delete.
Draft services: Delete allowed.

Ending should ask:

* Effective date
* Future visits
* Reason
* Notes

## Client Editing

Support:

* Phone
* Email
* Status
* Tags
* Preferred Contact
* Client Type
* Referral Source
* Communication Preferences

Billing addresses are handled by Stripe and do not need to exist inside HoundStack.

## Multiple Payment Methods

Clients may have multiple payment methods.
Managed through Stripe.

Display:

* Brand
* Last four
* Expiration
* Default

Actions:

* Set Default
* Remove
* Update

## Address Search

Current implementation should use Google Places Autocomplete (New).
Do NOT implement Pelias yet.

Requirements:

* USA only
* residential addresses first
* debounce
* minimum 3 characters
* workspace regional bias
* house-number priority
* autocomplete
* Place Details after selection
* structured address storage
* separate apartment/unit
* automatic marker placement
* automatic PostGIS zone lookup
* automatic boundary workflow

Backend should proxy Google requests.
Never expose API keys.
Keep the implementation behind an AddressProvider interface so Pelias can replace Google later without UI changes.

Do NOT implement USPS validation.

Label addresses: "Address Matched, Not USPS Verified."

Manual fallback:

* enter manually
* move marker
* draw boundary
* save as manually confirmed

## Mapping

Continue using:

* OpenStreetMap
* MapLibre or Leaflet
* Property boundaries
* PostGIS

Google should ONLY be responsible for address search.
Maps remain open-source.

## Activity

Unified audit timeline.

Include:

* Client edits
* Property edits
* Boundary changes
* Zone changes
* Pricing
* Services
* Notes
* Visits
* Invoices
* Payments
* Portal actions

Everything important should be recorded.

## Visual Design

Reduce excessive cards.

Prefer:

* One page container
* Persistent header
* Tabs
* Section headers
* Compact summaries
* Drawers
* Dividers
* Minimal borders
* Enterprise spacing
* Better typography

Avoid:

* Cards inside cards
* Always-open forms
* Large empty sections
* Tiny labels
* Hidden actions

## Technical Requirements

* Do not introduce duplicate schemas.
* Maintain historical integrity.
* Price changes must not affect historical invoices.
* Boundary changes should trigger recalculations safely.
* Archived items should disappear from operational views.
* Everything should be responsive.
* Everything should be keyboard accessible.

Implement:

* Loading states
* Empty states
* Validation states
* Error states
* Success states

## Definition of Done

The work is complete only when:

* Client page is read-only by default.
* Editing uses drawers.
* Property creation is hidden until requested.
* Service creation is hidden until requested.
* Boundaries display automatically.
* Yard size comes only from boundaries.
* Estimated time is calculated.
* Residential/commercial fields are conditional.
* Dogs belong to properties.
* Three note systems exist.
* Services support proper lifecycle management.
* Billing has been redesigned.
* Zone pricing functions correctly.
* Raw validation errors never appear.
* Activity timeline records all meaningful changes.
* Responsive behavior has been verified.
* Accessibility has been verified.
* Existing historical data remains intact.
