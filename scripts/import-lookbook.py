#!/usr/bin/env python3
"""Import labeled lookbook facts using written names, never portrait recognition.

Requires pypdf. The source PDF, generated JSON, and matching report are private
inputs/outputs and must not be copied to the public website or Git repository.
"""

import argparse
import hashlib
import json
import re
import unicodedata
from pathlib import Path

from pypdf import PdfReader


# Reviewed written-name variants. No fuzzy match is accepted automatically.
# Hyunjae/Justin was explicitly confirmed by the owner on 2026-10-31.
ALIASES = {
    "Deeptisai Ayyappaneni": ("deepti-ayyappaneni", "shortened first name"),
    "Angelus Cabanayan": ("angel-cabanayan", "shortened first name"),
    "Katelyn Craft": ("katy-craft", "nickname"),
    "Elizabeth Dawson": ("lizzie-dawson", "nickname"),
    "Danijela Doncevic": ("dani-doncevic", "shortened first name"),
    "Bethelhem Gobeze": ("betty-gobeze", "nickname"),
    "Zachary Goodman": ("zack-goodman", "nickname"),
    "Hyunjae Hahm": ("justin-hahm", "owner-confirmed alternate first name"),
    "Mei Lin Hainline": ("mei-hainline", "additional given-name part"),
    "Jonathan Ma": ("jon-ma", "shortened first name"),
    "Catherine Nikodem": ("cece-nikodem", "nickname"),
    "Harshawardhan Pande": ("harshu-pande", "shortened first name"),
    "Christopher Paul": ("chris-paul", "shortened first name"),
    "Bobak Purrahimi": ("bobak-pourrahimi", "surname spelling variant"),
    "Sammy Ramirez": ("sammy-ramirez-tovar", "additional family-name part"),
    "Nicholas Rawlings": ("nick-rawlings", "nickname"),
    "Nathaniel Schemmel": ("nate-schemmel", "nickname"),
    "Ibrahima Seck": ("ibra-seck", "shortened first name"),
    "Josephine Turner": ("joey-turner", "nickname"),
    "Nicholas Vacca": ("nick-vacca", "nickname"),
    "Abhinav Vayyeti": ("abhi-vayyeti", "shortened first name"),
    "Joshua Wilson": ("josh-wilson", "shortened first name"),
    "Yena (Elena)Woo": ("elena-woo", "alternate name explicitly in parentheses"),
}

FACT = re.compile(r"Fun\s*Fact\s*#?\s*([123])\s*:", re.IGNORECASE)
NEXT_PROMPT = re.compile(
    r"\n\s*(?:I\s+have never\s*\.{2,}|I\s+am excited about\s*\.{2,}|"
    r"1\s*nonmedical goal for this year\s*:|"
    r"Favorite\s+(?:food|movie/TV show|hobby|college/grad school memory)\s*:|"
    r"Something that never fails to make you smile\s*:)",
    re.IGNORECASE,
)


def normalize_name(value):
    ascii_name = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", ascii_name.lower())


def clean(value):
    return " ".join(value.split())


def extract_entry(text, page):
    heading = re.search(r"\bHometown\s*:", text, re.IGNORECASE)
    if not heading:
        if FACT.search(text):
            raise ValueError(f"Page {page}: facts exist but no written-name boundary was found.")
        return None
    name = clean(text[:heading.start()])
    if not name or len(name) > 150:
        raise ValueError(f"Page {page}: invalid written name.")
    markers = list(FACT.finditer(text))
    if [m.group(1) for m in markers] != ["1", "2", "3"]:
        raise ValueError(f"Page {page} ({name}): expected exactly Fun Fact #1, #2, #3 in order.")
    tail = text[markers[2].end():]
    next_prompt = NEXT_PROMPT.search(tail)
    end = markers[2].end() + next_prompt.start() if next_prompt else len(text)
    facts = [clean(text[marker.end():markers[i + 1].start() if i < 2 else end]) for i, marker in enumerate(markers)]
    for i, fact in enumerate(facts, 1):
        if not fact or len(fact) > 3000 or "\ufffd" in fact or "\x00" in fact:
            raise ValueError(f"Page {page} ({name}): fact #{i} needs extraction review.")
    return {"sourceName": name, "page": page, "facts": facts}


def cell(value):
    return str(value).replace("|", "\\|").replace("\n", " ")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, default=Path("Lookbook/Lookbook.pdf"))
    parser.add_argument("--roster", type=Path, default=Path("server/roster.json"))
    parser.add_argument("--output", type=Path, default=Path("server/lookbook.json"))
    parser.add_argument("--report", type=Path, default=Path("private/lookbook-match-report.md"))
    parser.add_argument("--aliases", type=Path, help="Optional reviewed JSON mapping of written names to roster IDs.")
    args = parser.parse_args()
    roster = json.loads(args.roster.read_text())
    by_id = {person["id"]: person for person in roster}
    by_name = {normalize_name(person["name"]): person for person in roster}
    if len(by_id) != len(roster) or len(by_name) != len(roster):
        raise ValueError("Duplicate roster IDs or normalized names require explicit review.")
    aliases = {normalize_name(name): value for name, value in ALIASES.items()}
    if args.aliases:
        for name, person_id in json.loads(args.aliases.read_text()).items():
            aliases[normalize_name(name)] = (person_id, "external reviewed alias")
    for person_id, _ in aliases.values():
        if person_id not in by_id:
            raise ValueError(f"Alias references an unknown roster ID: {person_id}")
    pdf = PdfReader(args.pdf)
    matched, unmatched, methods, seen_names, seen_ids = [], [], [], set(), set()
    for page_number, pdf_page in enumerate(pdf.pages, 1):
        entry = extract_entry(pdf_page.extract_text(), page_number)
        if entry is None:
            continue
        normalized = normalize_name(entry["sourceName"])
        if normalized in seen_names:
            raise ValueError(f"Duplicate lookbook name on page {page_number}: {entry['sourceName']}")
        seen_names.add(normalized)
        person = by_name.get(normalized)
        method = "exact/normalized written name"
        if person is None and normalized in aliases:
            person_id, reason = aliases[normalized]
            person = by_id[person_id]
            method = "reviewed alias: " + reason
        if person is None:
            unmatched.append(entry)
            continue
        if person["id"] in seen_ids:
            raise ValueError(f"Two lookbook pages map to roster ID {person['id']}; review before importing.")
        seen_ids.add(person["id"])
        matched.append({"id": person["id"], "name": person["name"], **entry})
        methods.append(method)
    if not matched:
        raise ValueError("No lookbook entries matched the roster; refusing to write an empty import.")
    exact_count = sum(method.startswith("exact/") for method in methods)
    missing = [person for person in roster if person["id"] not in seen_ids]
    report = [
        "# Private lookbook match report", "",
        f"Source: `{args.pdf}`", f"SHA-256: `{hashlib.sha256(args.pdf.read_bytes()).hexdigest()}`", "",
        f"- PDF pages: {len(pdf.pages)} (including cover).",
        f"- Named entries with three labeled facts: {len(matched) + len(unmatched)}.",
        f"- Matched roster entries: {len(matched)} ({exact_count} exact/normalized; {len(matched) - exact_count} reviewed aliases).",
        f"- Lookbook names with no accepted roster match: {len(unmatched)}.",
        f"- Roster entries without a matched lookbook page: {len(missing)}.", "",
        "Only written names were matched. Portraits were not used for identity matching. Fact wording and order are preserved; wrapping whitespace is collapsed and the labels are omitted.", "",
        "Hyunjae Hahm → Justin Hahm was explicitly confirmed by the owner on 2026-10-31. Other aliases were reviewed as compatible nicknames, name-part differences, or spelling variants with matching family names.", "",
        "## Matched entries", "", "| PDF page | Written lookbook name | Roster name | Method |", "| --- | --- | --- | --- |",
    ]
    for entry, method in zip(matched, methods):
        report.append("| " + " | ".join(cell(value) for value in [entry["page"], entry["sourceName"], entry["name"], method]) + " |")
    report.extend(["", "## Lookbook names not mapped to the roster", ""])
    report.extend(f"- Page {entry['page']}: {entry['sourceName']}" for entry in unmatched)
    report.extend(["", "## Roster names without matched facts", ""])
    report.extend(f"- {person['name']} (`{person['id']}`)" for person in missing)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(matched, indent=2, ensure_ascii=False) + "\n")
    args.report.write_text("\n".join(report) + "\n")
    print(f"Imported {len(matched)} classmates: {exact_count} exact/normalized and {len(matched) - exact_count} reviewed aliases. {len(unmatched)} lookbook names unmatched; {len(missing)} roster names have no matched page.")
    print(f"Private output: {args.output}; private review report: {args.report}")


if __name__ == "__main__":
    main()
