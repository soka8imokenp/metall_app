Bu maqola **Sozlamalar** bo‘limi ochiq bo‘lgan odamlar uchun.

Yangilash — bu tizimni serverda yangilash: yangi kod, frontning yangi yig‘masi,
kerak bo‘lsa bazadagi o‘zgarishlar.

## Hozirgi versiyani qanday bilish mumkin

Versiya raqami chap menyuning eng pastida ko‘rinadi. Xuddi shu raqam stend
serverida `/version.json` manzilida yotadi — u yerda raqam ham, yig‘ilish vaqti
ham ko‘rinadi.

Raqam `942a76a-202610061309` ko‘rinishida bo‘ladi: kommitning qisqa raqami va
yig‘ilish vaqti. Shu raqam bo‘yicha dasturchi sizda aynan nima turganini
aniq tushunadi.

## «Yangi versiya chiqdi» tasmasi

Serverda yangi yig‘ma paydo bo‘lganda barcha ochiq varaqlarning yuqorisida tasma
chiqadi: «Tizimning yangi versiyasi chiqdi. Yangilanishlarni ko‘rish uchun
sahifani qayta yuklang» va **Qayta yuklash** tugmasi.

> Tasmani yopmasdan bosish kerak. Eski varaq eski kod bilan ishlashda davom
> etadi, server bilan farq chiqqanda esa boshqa hech kimda bo‘lmagan xatolar
> paydo bo‘ladi.

## Yangilash qanday boradi

Stendga yangilashni dasturchi bitta buyruq bilan qiladi — `scripts/deploy-stand.sh`.
Skript bekend va frontni yig‘adi, baza o‘zgarishlarini qo‘llaydi va **o‘zini
tashqaridan o‘zi tekshiradi**: ommaviy manzil qaytargan versiyani hozir
yig‘ilgani bilan solishtiradi. To‘g‘ri kelmasa — yangilash bo‘lgan hisoblanmaydi.

Skript nima **qilmaydi**: prodga tegmaydi, botni va tunnelni qayta
ishga tushirmaydi. Bular alohida qarorlar.

## Yangilashdan keyin nima qilish kerak

1. Tasmadagi tugma bilan sahifani qayta yuklang.
2. `/version.json` ni tekshiring — u yerda yangi raqam bo‘lishi kerak.
3. O‘z ish bo‘limingizni oching va bitta oddiy amalni bajarib ko‘ring.

## Agar yangilashdan keyin nimadir buzilgan bo‘lsa

Dasturchiga menyu pastidagi **versiya raqami** ni va aynan nima qilganingizni
ayting. Versiya raqami — birinchi so‘raydigan narsa: usiz ekraningizda qanday
kod turganini bilish mumkin emas.
