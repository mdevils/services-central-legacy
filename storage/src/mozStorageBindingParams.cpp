/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: sw=2 ts=2 et lcs=trail\:.,tab\:>~ :
 * ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is mozilla.org code.
 *
 * The Initial Developer of the Original Code is
 * Mozilla Corporation.
 * Portions created by the Initial Developer are Copyright (C) 2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Shawn Wilsher <me@shawnwilsher.com> (Original Author)
 *   Andrew Sutherland <asutherland@asutherland.org>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

#include <limits.h>

#include "nsString.h"

#include "mozStorageError.h"
#include "mozStoragePrivateHelpers.h"
#include "mozStorageBindingParams.h"
#include "mozStorageBindingParamsArray.h"
#include "Variant.h"

namespace mozilla {
namespace storage {

////////////////////////////////////////////////////////////////////////////////
//// Local Helper Objects

namespace {

struct BindingColumnData
{
  BindingColumnData(sqlite3_stmt *aStmt,
                    int aColumn)
  : stmt(aStmt)
  , column(aColumn)
  {
  }
  sqlite3_stmt *stmt;
  int column;
};

////////////////////////////////////////////////////////////////////////////////
//// Variant Specialization Functions (variantToSQLiteT)

int
sqlite3_T_int(BindingColumnData aData,
              int aValue)
{
  return ::sqlite3_bind_int(aData.stmt, aData.column + 1, aValue);
}

int
sqlite3_T_int64(BindingColumnData aData,
                sqlite3_int64 aValue)
{
  return ::sqlite3_bind_int64(aData.stmt, aData.column + 1, aValue);
}

int
sqlite3_T_double(BindingColumnData aData,
                 double aValue)
{
  return ::sqlite3_bind_double(aData.stmt, aData.column + 1, aValue);
}

int
sqlite3_T_text(BindingColumnData aData,
               const nsCString& aValue)
{
  return ::sqlite3_bind_text(aData.stmt,
                             aData.column + 1,
                             aValue.get(),
                             aValue.Length(),
                             SQLITE_TRANSIENT);
}

int
sqlite3_T_text16(BindingColumnData aData,
                 const nsString& aValue)
{
  return ::sqlite3_bind_text16(aData.stmt,
                               aData.column + 1,
                               aValue.get(),
                               aValue.Length() * 2, // Length in bytes!
                               SQLITE_TRANSIENT);
}

int
sqlite3_T_null(BindingColumnData aData)
{
  return ::sqlite3_bind_null(aData.stmt, aData.column + 1);
}

int
sqlite3_T_blob(BindingColumnData aData,
               const void *aBlob,
               int aSize)
{
  return ::sqlite3_bind_blob(aData.stmt, aData.column + 1, aBlob, aSize,
                             NS_Free);

}

#include "variantToSQLiteT_impl.h"

} // anonymous namespace

////////////////////////////////////////////////////////////////////////////////
//// BindingParams

BindingParams::BindingParams(mozIStorageBindingParamsArray *aOwningArray,
                             Statement *aOwningStatement)
: mLocked(false)
, mOwningArray(aOwningArray)
, mOwningStatement(aOwningStatement)
{
  (void)mOwningStatement->GetParameterCount(&mParamCount);
  (void)mParameters.SetCapacity(mParamCount);
}

BindingParams::BindingParams(mozIStorageBindingParamsArray *aOwningArray)
: mLocked(false)
, mOwningArray(aOwningArray)
, mOwningStatement(nsnull)
, mParamCount(0)
{
}

AsyncBindingParams::AsyncBindingParams(
  mozIStorageBindingParamsArray *aOwningArray
)
: BindingParams(aOwningArray)
{
  mNamedParameters.Init();
}

void
BindingParams::lock()
{
  NS_ASSERTION(mLocked == false, "Parameters have already been locked!");
  mLocked = true;

  // We no longer need to hold a reference to our statement or our owning array.
  // The array owns us at this point, and it will own a reference to the
  // statement.
  mOwningStatement = nsnull;
  mOwningArray = nsnull;
}

void
BindingParams::unlock(Statement *aOwningStatement)
{
  NS_ASSERTION(mLocked == true, "Parameters were not yet locked!");
  mLocked = false;
  mOwningStatement = aOwningStatement;
}

const mozIStorageBindingParamsArray *
BindingParams::getOwner() const
{
  return mOwningArray;
}

PLDHashOperator
AsyncBindingParams::iterateOverNamedParameters(const nsACString &aName,
                                               nsIVariant *aValue,
                                               void *voidClosureThunk)
{
  NamedParameterIterationClosureThunk *closureThunk =
    static_cast<NamedParameterIterationClosureThunk *>(voidClosureThunk);

  // We do not accept any forms of names other than ":name", but we need to add
  // the colon for SQLite.
  nsCAutoString name(":");
  name.Append(aName);
  int oneIdx = ::sqlite3_bind_parameter_index(closureThunk->statement,
                                              name.get());

  if (oneIdx == 0) {
    nsCAutoString errMsg(aName);
    errMsg.Append(NS_LITERAL_CSTRING(" is not a valid named parameter."));
    closureThunk->err = new Error(SQLITE_RANGE, errMsg.get());
    return PL_DHASH_STOP;
  }

  // XPCVariant's AddRef and Release are not thread-safe and so we must not do
  // anything that would invoke them here on the async thread.  As such we can't
  // cram aValue into self->mParameters using ReplaceObjectAt so that we can
  // freeload off of the BindingParams::Bind implementation.
  int rc = variantToSQLiteT(BindingColumnData(closureThunk->statement,
                                              oneIdx - 1),
                            aValue);
  if (rc != SQLITE_OK) {
    // We had an error while trying to bind.  Now we need to create an error
    // object with the right message.  Note that we special case
    // SQLITE_MISMATCH, but otherwise get the message from SQLite.
    const char *msg = "Could not covert nsIVariant to SQLite type.";
    if (rc != SQLITE_MISMATCH)
      msg = ::sqlite3_errmsg(::sqlite3_db_handle(closureThunk->statement));

    closureThunk->err = new Error(rc, msg);
    return PL_DHASH_STOP;
  }
  return PL_DHASH_NEXT;
}

////////////////////////////////////////////////////////////////////////////////
//// nsISupports

NS_IMPL_THREADSAFE_ISUPPORTS2(
  BindingParams
, mozIStorageBindingParams
, IStorageBindingParamsInternal
)


////////////////////////////////////////////////////////////////////////////////
//// IStorageBindingParamsInternal

already_AddRefed<mozIStorageError>
BindingParams::bind(sqlite3_stmt *aStatement)
{
  // Iterate through all of our stored data, and bind it.
  for (PRInt32 i = 0; i < mParameters.Count(); i++) {
    int rc = variantToSQLiteT(BindingColumnData(aStatement, i), mParameters[i]);
    if (rc != SQLITE_OK) {
      // We had an error while trying to bind.  Now we need to create an error
      // object with the right message.  Note that we special case
      // SQLITE_MISMATCH, but otherwise get the message from SQLite.
      const char *msg = "Could not covert nsIVariant to SQLite type.";
      if (rc != SQLITE_MISMATCH)
        msg = ::sqlite3_errmsg(::sqlite3_db_handle(aStatement));

      nsCOMPtr<mozIStorageError> err(new Error(rc, msg));
      return err.forget();
    }
  }

  return nsnull;
}

already_AddRefed<mozIStorageError>
AsyncBindingParams::bind(sqlite3_stmt * aStatement)
{
  // We should bind by index using the super-class if there is nothing in our
  // hashtable.
  if (!mNamedParameters.Count())
    return BindingParams::bind(aStatement);

  // Enumerate over everyone in the map, propagating them into mParameters if
  // we can and creating an error immediately when we cannot.
  NamedParameterIterationClosureThunk closureThunk = {this, aStatement, nsnull};
  (void)mNamedParameters.EnumerateRead(iterateOverNamedParameters,
                                       (void *)&closureThunk);

  return closureThunk.err.forget();
}


///////////////////////////////////////////////////////////////////////////////
//// mozIStorageBindingParams

NS_IMETHODIMP
BindingParams::BindByName(const nsACString &aName,
                          nsIVariant *aValue)
{
  NS_ENSURE_FALSE(mLocked, NS_ERROR_UNEXPECTED);

  // Get the column index that we need to store this at.
  PRUint32 index;
  nsresult rv = mOwningStatement->GetParameterIndex(aName, &index);
  NS_ENSURE_SUCCESS(rv, rv);

  return BindByIndex(index, aValue);
}

NS_IMETHODIMP
AsyncBindingParams::BindByName(const nsACString &aName,
                               nsIVariant *aValue)
{
  NS_ENSURE_FALSE(mLocked, NS_ERROR_UNEXPECTED);

  mNamedParameters.Put(aName, aValue);
  return NS_OK;
}


NS_IMETHODIMP
BindingParams::BindUTF8StringByName(const nsACString &aName,
                                    const nsACString &aValue)
{
  nsCOMPtr<nsIVariant> value(new UTF8TextVariant(aValue));
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByName(aName, value);
}

NS_IMETHODIMP
BindingParams::BindStringByName(const nsACString &aName,
                                const nsAString &aValue)
{
  nsCOMPtr<nsIVariant> value(new TextVariant(aValue));
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByName(aName, value);
}

NS_IMETHODIMP
BindingParams::BindDoubleByName(const nsACString &aName,
                                double aValue)
{
  nsCOMPtr<nsIVariant> value(new FloatVariant(aValue));
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByName(aName, value);
}

NS_IMETHODIMP
BindingParams::BindInt32ByName(const nsACString &aName,
                               PRInt32 aValue)
{
  nsCOMPtr<nsIVariant> value(new IntegerVariant(aValue));
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByName(aName, value);
}

NS_IMETHODIMP
BindingParams::BindInt64ByName(const nsACString &aName,
                               PRInt64 aValue)
{
  nsCOMPtr<nsIVariant> value(new IntegerVariant(aValue));
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByName(aName, value);
}

NS_IMETHODIMP
BindingParams::BindNullByName(const nsACString &aName)
{
  nsCOMPtr<nsIVariant> value(new NullVariant());
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByName(aName, value);
}

NS_IMETHODIMP
BindingParams::BindBlobByName(const nsACString &aName,
                              const PRUint8 *aValue,
                              PRUint32 aValueSize)
{
  NS_ENSURE_ARG_MAX(aValueSize, INT_MAX);
  std::pair<const void *, int> data(
    static_cast<const void *>(aValue),
    int(aValueSize)
  );
  nsCOMPtr<nsIVariant> value(new BlobVariant(data));
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByName(aName, value);
}

NS_IMETHODIMP
BindingParams::BindByIndex(PRUint32 aIndex,
                           nsIVariant *aValue)
{
  NS_ENSURE_FALSE(mLocked, NS_ERROR_UNEXPECTED);
  ENSURE_INDEX_VALUE(aIndex, mParamCount);

  // Store the variant for later use.
  NS_ENSURE_TRUE(mParameters.ReplaceObjectAt(aValue, aIndex),
                 NS_ERROR_OUT_OF_MEMORY);
  return NS_OK;
}

NS_IMETHODIMP
AsyncBindingParams::BindByIndex(PRUint32 aIndex,
                                nsIVariant *aValue)
{
  NS_ENSURE_FALSE(mLocked, NS_ERROR_UNEXPECTED);
  // In the asynchronous case we do not know how many parameters there are to
  // bind to, so we cannot check the validity of aIndex.

  // Store the variant for later use.
  NS_ENSURE_TRUE(mParameters.ReplaceObjectAt(aValue, aIndex),
                 NS_ERROR_OUT_OF_MEMORY);
  return NS_OK;
}

NS_IMETHODIMP
BindingParams::BindUTF8StringByIndex(PRUint32 aIndex,
                                     const nsACString &aValue)
{
  nsCOMPtr<nsIVariant> value(new UTF8TextVariant(aValue));
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByIndex(aIndex, value);
}

NS_IMETHODIMP
BindingParams::BindStringByIndex(PRUint32 aIndex,
                                 const nsAString &aValue)
{
  nsCOMPtr<nsIVariant> value(new TextVariant(aValue));
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByIndex(aIndex, value);
}

NS_IMETHODIMP
BindingParams::BindDoubleByIndex(PRUint32 aIndex,
                                 double aValue)
{
  nsCOMPtr<nsIVariant> value(new FloatVariant(aValue));
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByIndex(aIndex, value);
}

NS_IMETHODIMP
BindingParams::BindInt32ByIndex(PRUint32 aIndex,
                                PRInt32 aValue)
{
  nsCOMPtr<nsIVariant> value(new IntegerVariant(aValue));
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByIndex(aIndex, value);
}

NS_IMETHODIMP
BindingParams::BindInt64ByIndex(PRUint32 aIndex,
                                PRInt64 aValue)
{
  nsCOMPtr<nsIVariant> value(new IntegerVariant(aValue));
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByIndex(aIndex, value);
}

NS_IMETHODIMP
BindingParams::BindNullByIndex(PRUint32 aIndex)
{
  nsCOMPtr<nsIVariant> value(new NullVariant());
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByIndex(aIndex, value);
}

NS_IMETHODIMP
BindingParams::BindBlobByIndex(PRUint32 aIndex,
                               const PRUint8 *aValue,
                               PRUint32 aValueSize)
{
  NS_ENSURE_ARG_MAX(aValueSize, INT_MAX);
  std::pair<const void *, int> data(
    static_cast<const void *>(aValue),
    int(aValueSize)
  );
  nsCOMPtr<nsIVariant> value(new BlobVariant(data));
  NS_ENSURE_TRUE(value, NS_ERROR_OUT_OF_MEMORY);

  return BindByIndex(aIndex, value);
}

} // namespace storage
} // namespace mozilla
